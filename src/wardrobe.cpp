#include "wardrobe.h"

#include "actor_identity.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <filesystem>
#include <fstream>
#include <atomic>
#include <mutex>
#include <random>
#include <unordered_set>

// pch (force-included) provides RE::/SKSE::, nlohmann json.hpp (as nlohmann::json),
// `namespace logger = SKSE::log`, and `using namespace std::literals`.

namespace Wardrobe
{
	// Defined after the catalogue helpers; used by both delete paths above them.
	static void Tombstone(const std::string& name);

	namespace
	{
		// ---- the mod-event protocol to HD_WardrobeExec.psc ----
		// The actor rides on `sender` (a TESForm*) because numArg is a float and
		// cannot carry a 32-bit FormID without loss.
		constexpr auto kEvDress  = "HD_Wardrobe_Dress";   // strArg = outfit name,  sender = actor
		constexpr auto kEvSetLoc = "HD_Wardrobe_SetLoc";  // strArg = outfit name,  numArg = locType, sender = actor
		constexpr auto kEvClrLoc = "HD_Wardrobe_ClrLoc";  // numArg = locType,      sender = actor
		constexpr auto kEvTrack  = "HD_Wardrobe_Track";   // numArg = 1 track / 0 untrack, sender = actor
		constexpr auto kEvExport = "HD_Wardrobe_Export";  // no args — dump state to json
		constexpr auto kEvNewFit = "HD_Wardrobe_NewOutfit";  // strArg = outfit name (creates/empties it)
		constexpr auto kEvAddPc  = "HD_Wardrobe_AddPiece";   // strArg = outfit name, sender = Armor
		constexpr auto kEvDelFit = "HD_Wardrobe_DelOutfit";  // strArg = outfit name
		constexpr auto kEvDelPc  = "HD_Wardrobe_DelPiece";   // strArg = outfit name, sender = Armor
		constexpr auto kEvImport = "HD_Wardrobe_Import";     // strArg = "plugin" or "plugin|EditorID"
		constexpr auto kEvInvMod = "HD_Wardrobe_InvMode";    // strArg = "player"|"npc", numArg = 1 auto / 2 immersive
		constexpr auto kEvEnable = "HD_Wardrobe_Enable";     // numArg = 1 on / 0 off
		constexpr auto kEvRefAll = "HD_Wardrobe_RefreshAll"; // no args
		constexpr auto kEvReset  = "HD_Wardrobe_ResetAuto";  // no args
		constexpr auto kEvRename = "HD_Wardrobe_RenOutfit";  // strArg = "old|new"
		constexpr auto kEvFav    = "HD_Wardrobe_Fav";        // strArg = outfit name, numArg = 1 on / 0 off
		constexpr auto kEvSys    = "HD_Wardrobe_Sys";        // strArg = "quickslot"|"climate", numArg = 1/0

		std::mutex                       g_catMutex;
		bool                             g_catOk = false;
		// True between asking SOES to export and the export landing. Without this
		// the view cannot tell "SOES is missing" from "SOES has not answered yet",
		// and it showed the alarming version for both.
		std::atomic<bool>                g_catPending{ false };
		std::vector<std::pair<std::string, int>> g_catalogue;   // outfit name -> piece count
		// Deleted-outfit tombstones. The catalogue everyone DISPLAYS is SOES's
		// own export, which refreshes ~90 s after a delete lands — Rober deleted
		// AlikrSteel and watched it stay. A tombstoned name is filtered out of
		// the cache and the named export immediately, and the tombstone clears
		// itself the first time a fresh export truly no longer carries the name.
		// Guarded by g_catMutex.
		std::unordered_set<std::string> g_deletedNames;
		std::vector<std::string>         g_tracked;             // "0xLOCAL|Plugin.esp"
		std::vector<std::pair<std::string, std::string>> g_wearing;  // actorKey -> outfit

		void Notify(const std::string& m) { RE::DebugNotification(m.c_str()); }

		std::string Lower(std::string s)
		{
			std::transform(s.begin(), s.end(), s.begin(),
				[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			return s;
		}

		std::string   HexOf(std::uint32_t v) { return ActorIdentity::HexOf(v); }
		std::uint32_t ParseHex(const std::string& s) { return ActorIdentity::ParseHex(s); }

		// THE identity, and it must land on SOES's own spelling — SOES-NG writes
		// "0x81a|NWS_Elana.esp" (local id, lowercase, defining plugin) and this
		// key is compared against those strings in TrackedKey/WearingKey.
		//
		// It used to be plain concatenation, and that quietly broke every badge on
		// the tab: Follower Organizer hands the deck a RUNTIME FormID and NO
		// plugin, so the key it built was "0x0001A69A|" or "0xFECED81A|" and could
		// never equal SOES's "0x1a69a|Skyrim.esm". Nobody was ever shown as
		// tracked. ActorIdentity::Key() resolves the pair and re-spells it the
		// durable way first, so both sides agree — and a load-order shift, which
		// moves every light plugin's runtime ids, stops mattering.
		std::string ActorKey(const std::string& formId, const std::string& plugin)
		{
			return ActorIdentity::Key(formId, plugin);
		}

		// Shared with the NFF side. The private copy this replaced handed a full
		// runtime id to LookupForm together with a plugin, which cannot resolve —
		// LookupFormID ADDS the file prefix instead of masking (actor_identity.h).
		RE::Actor* ResolveActor(const std::string& formId, const std::string& plugin)
		{
			return ActorIdentity::ResolveActor(formId, plugin);
		}

		// The inverse: the durable identity of a live form.
		// One implementation, in ActorIdentity — three byte-identical private
		// copies of this used to exist, and none of them were the one the crash
		// sites called. Same contract as before: the durable local id, falling
		// back to the runtime id for a dynamic form. Now also null-form-safe.
		std::uint32_t LocalIdOf(const RE::TESForm* form)
		{
			return ActorIdentity::BestIdOf(form);
		}
		std::string PluginOf(const RE::TESForm* form)
		{
			if (auto* file = form->GetFile(0))
				return std::string(file->GetFilename());
			return "";
		}

		// Resolve an ARMOR from the durable (local FormID + plugin) pair the
		// inventory export and the portal both speak.
		RE::TESObjectARMO* ResolveArmor(const std::string& formId, const std::string& plugin)
		{
			const std::uint32_t local = ParseHex(formId);
			if (!local)
				return nullptr;
			if (!plugin.empty()) {
				auto* dh = RE::TESDataHandler::GetSingleton();
				if (dh) {
					if (auto* f = dh->LookupForm(local, plugin))
						return f->As<RE::TESObjectARMO>();
				}
			}
			if (auto* f = RE::TESForm::LookupByID(local))
				return f->As<RE::TESObjectARMO>();
			return nullptr;
		}

		// The most significant biped slot, for grouping the inventory by where a
		// piece is worn. Mirrors TailorHelper's GetSlotName so both feeds agree.
		std::string SlotNameOf(RE::TESObjectARMO* armo)
		{
			using Slot = RE::BIPED_MODEL::BipedObjectSlot;
			// GetSlotMask() returns the raw bit-flag enum, NOT an EnumSet — there
			// is no .any() on it. Test the bits directly. (TailorHelper gets away
			// with .any() only because it takes a REX::EnumSet PARAMETER and the
			// enum converts on the way in.)
			const auto mask = static_cast<std::uint32_t>(armo->GetSlotMask());
			const auto has  = [mask](Slot sl) {
				return (mask & static_cast<std::uint32_t>(sl)) != 0;
			};
			if (has(Slot::kBody))     return "Body";
			if (has(Slot::kHead))     return "Head";
			if (has(Slot::kHair))     return "Hair";
			if (has(Slot::kLongHair)) return "Hair";
			if (has(Slot::kCirclet))  return "Circlet";
			if (has(Slot::kHands))    return "Hands";
			if (has(Slot::kForearms)) return "Forearms";
			if (has(Slot::kFeet))     return "Feet";
			if (has(Slot::kCalves))   return "Calves";
			if (has(Slot::kShield))   return "Shield";
			if (has(Slot::kAmulet))   return "Amulet";
			if (has(Slot::kRing))     return "Ring";
			// Everything past here is a "mod" slot — the ones vanilla never gave a
			// name to, which is exactly why the Wardrobe read "Unknown" for most of
			// Immersive Jewelry (earrings sit on 43, facial pieces on 55, chokers on
			// 45). Strictly ADDITIVE: every vanilla-slotted piece already returned
			// above, so no existing grouping moves. Slots 50/51 (decapitate) and 61
			// (FX01) stay Unknown on purpose — they are never worn gear.
			if (has(Slot::kEars))               return "Ears";
			if (has(Slot::kModFaceJewelry))     return "Face";
			if (has(Slot::kModMouth))           return "Mouth";
			if (has(Slot::kModNeck))            return "Neck";
			if (has(Slot::kModChestPrimary) ||
			    has(Slot::kModChestSecondary))  return "Chest";
			if (has(Slot::kModBack))            return "Back";
			if (has(Slot::kModShoulder))        return "Shoulder";
			if (has(Slot::kModArmLeft) ||
			    has(Slot::kModArmRight))        return "Arms";
			if (has(Slot::kModPelvisPrimary) ||
			    has(Slot::kModPelvisSecondary)) return "Pelvis";
			if (has(Slot::kModLegRight) ||
			    has(Slot::kModLegLeft))         return "Legs";
			if (has(Slot::kTail))               return "Tail";
			if (has(Slot::kModMisc1) ||
			    has(Slot::kModMisc2))           return "Misc";
			return "Unknown";
		}

		double DaysPassed()
		{
			auto* cal = RE::Calendar::GetSingleton();
			return cal ? static_cast<double>(cal->GetDaysPassed()) : 0.0;
		}

		// ---- mod event out ----
		void SendEvent(const char* name, const std::string& str, float num, RE::TESForm* sender)
		{
			auto* src = SKSE::GetModCallbackEventSource();
			if (!src) {
				logger::warn("Wardrobe: no mod callback event source");
				return;
			}
			SKSE::ModCallbackEvent ev{ name, str.c_str(), num, sender };
			src->SendEvent(&ev);
		}

		std::filesystem::path SoesDataFile()
		{
			// SOES's ExportSettings() writes here. MO2 redirects it into the
			// profile's overwrite tree at runtime, which is where we read it from.
			return std::filesystem::path("Data") / "SKSE" / "Plugins" / "OutfitEquipmentSystemNGData.json";
		}
		std::filesystem::path PortalFile()
		{
			return std::filesystem::path("Data") / "PrismaUI" / "views" / "HotkeyDeck" / "portal-wardrobe.json";
		}

		// ---- json helpers for the slice ----
		nlohmann::json CatJson(const Category& c)
		{
			return nlohmann::json{ { "id", c.id }, { "name", c.name }, { "hue", c.hue } };
		}
		Category CatFrom(const nlohmann::json& j)
		{
			Category c;
			if (!j.is_object())
				return c;
			c.id   = j.value("id", std::string(""));
			c.name = j.value("name", std::string(""));
			c.hue  = j.value("hue", 38);
			return c;
		}

		// ---- the pill row (tags + "she owns this"), shared by outfits and pools --
		// One reader and one writer for both, because an outfit's pills and a
		// wardrobe's pills are the same feature and drifting them apart is how
		// half a feature ships. Capped and trimmed on the way IN: the view is
		// trusted to be sane, a hand-edited config is not, and an unbounded tag
		// list would be drawn as an unbounded row of pills.
		constexpr std::size_t kMaxTags = 24;
		constexpr std::size_t kMaxTagLen = 40;

		nlohmann::json TagsJson(const std::vector<std::string>& tags,
			const std::vector<NpcTag>&                          forNpcs)
		{
			nlohmann::json who = nlohmann::json::array();
			for (const auto& t : forNpcs)
				who.push_back(nlohmann::json{ { "key", t.key }, { "name", t.name } });
			return nlohmann::json{ { "tags", tags }, { "forNpcs", std::move(who) } };
		}
		void TagsFrom(const nlohmann::json& j, std::vector<std::string>& tags,
			std::vector<NpcTag>&             forNpcs)
		{
			if (j.contains("tags") && j["tags"].is_array())
				for (const auto& t : j["tags"]) {
					if (!t.is_string() || tags.size() >= kMaxTags)
						continue;
					auto v = t.get<std::string>();
					if (v.size() > kMaxTagLen)
						v.resize(kMaxTagLen);
					if (!v.empty())
						tags.push_back(v);
				}
			if (j.contains("forNpcs") && j["forNpcs"].is_array())
				for (const auto& e : j["forNpcs"]) {
					if (!e.is_object() || forNpcs.size() >= kMaxTags)
						continue;
					NpcTag t;
					t.key  = e.value("key", std::string(""));
					t.name = e.value("name", std::string(""));
					if (!t.key.empty())
						forNpcs.push_back(std::move(t));
				}
		}

		nlohmann::json MetaJson(const OutfitMeta& m)
		{
			auto j = nlohmann::json{ { "name", m.name }, { "image", m.image }, { "note", m.note },
				{ "categoryIds", m.categoryIds }, { "fav", m.fav } };
			j.update(TagsJson(m.tags, m.forNpcs));
			return j;
		}
		OutfitMeta MetaFrom(const nlohmann::json& j)
		{
			OutfitMeta m;
			if (!j.is_object())
				return m;
			m.name  = j.value("name", std::string(""));
			m.image = j.value("image", std::string(""));
			m.note  = j.value("note", std::string(""));
			m.fav   = j.value("fav", false);
			if (j.contains("categoryIds") && j["categoryIds"].is_array())
				for (const auto& c : j["categoryIds"])
					if (c.is_string())
						m.categoryIds.push_back(c.get<std::string>());
			TagsFrom(j, m.tags, m.forNpcs);
			return m;
		}

		nlohmann::json PoolJson(const Pool& p)
		{
			auto j = nlohmann::json{ { "id", p.id }, { "name", p.name }, { "note", p.note },
				{ "hue", p.hue }, { "outfits", p.outfits }, { "mode", p.mode }, { "bag", p.bag } };
			j.update(TagsJson(p.tags, p.forNpcs));
			return j;
		}
		Pool PoolFrom(const nlohmann::json& j)
		{
			Pool p;
			if (!j.is_object())
				return p;
			p.id   = j.value("id", std::string(""));
			p.name = j.value("name", std::string(""));
			p.note = j.value("note", std::string(""));
			p.hue  = j.value("hue", 38);
			p.mode = j.value("mode", std::string("bag"));
			if (p.mode != "bag" && p.mode != "random")
				p.mode = "bag";
			if (j.contains("outfits") && j["outfits"].is_array())
				for (const auto& o : j["outfits"])
					if (o.is_string())
						p.outfits.push_back(o.get<std::string>());
			if (j.contains("bag") && j["bag"].is_array())
				for (const auto& o : j["bag"])
					if (o.is_string())
						p.bag.push_back(o.get<std::string>());
			TagsFrom(j, p.tags, p.forNpcs);
			return p;
		}

		nlohmann::json AssignJson(const Assignment& a)
		{
			nlohmann::json ov = nlohmann::json::array();
			for (const auto& o : a.locationOverrides)
				ov.push_back(nlohmann::json{ { "loc", o.loc }, { "wardrobeId", o.wardrobeId },
					{ "outfit", o.outfit } });
			return nlohmann::json{ { "formId", a.formId }, { "plugin", a.plugin }, { "name", a.name },
				{ "mode", a.mode }, { "wardrobeId", a.wardrobeId }, { "outfit", a.outfit },
				{ "cadenceHours", a.cadenceHours }, { "locationOverrides", ov },
				{ "lastRollDay", a.lastRollDay }, { "lastOutfit", a.lastOutfit } };
		}
		Assignment AssignFrom(const nlohmann::json& j)
		{
			Assignment a;
			if (!j.is_object())
				return a;
			a.formId       = j.value("formId", std::string(""));
			a.plugin       = j.value("plugin", std::string(""));
			a.name         = j.value("name", std::string(""));
			a.mode         = j.value("mode", std::string("off"));
			a.wardrobeId   = j.value("wardrobeId", std::string(""));
			a.outfit       = j.value("outfit", std::string(""));
			a.cadenceHours = j.value("cadenceHours", 0);
			a.lastRollDay  = j.value("lastRollDay", 0.0);
			a.lastOutfit   = j.value("lastOutfit", std::string(""));
			if (j.contains("locationOverrides") && j["locationOverrides"].is_array())
				for (const auto& o : j["locationOverrides"]) {
					if (!o.is_object())
						continue;
					LocOverride lo;
					lo.loc        = o.value("loc", 0);
					lo.wardrobeId = o.value("wardrobeId", std::string(""));
					lo.outfit     = o.value("outfit", std::string(""));
					a.locationOverrides.push_back(lo);
				}
			if (a.mode != "off" && a.mode != "outfit" && a.mode != "wardrobe")
				a.mode = "off";
			// A hostile or stale cadence must not make the tick spin.
			a.cadenceHours = std::clamp(a.cadenceHours, 0, 24 * 30);
			return a;
		}

		// Non-const: the shuffle bag lives on the Pool, so rolling mutates it.
		Pool* FindPool(Config& c, const std::string& id)
		{
			for (auto& p : c.wardrobes)
				if (p.id == id)
					return &p;
			return nullptr;
		}
		// By IDENTITY, never by string equality: the view echoes back whatever
		// spelling it was handed (FO's runtime id, no plugin) while the config now
		// stores the durable pair, and "0xFECED81A|" and "0x81a|NWS_Elana.esp" are
		// the same woman.
		Assignment* FindAssign(Config& c, const std::string& formId, const std::string& plugin)
		{
			const auto want = ActorKey(formId, plugin);
			for (auto& a : c.assignments)
				if (ActorKey(a.formId, a.plugin) == want)
					return &a;
			return nullptr;
		}

		bool CatalogueHas(const std::string& name)
		{
			std::lock_guard lock(g_catMutex);
			if (!g_catOk)
				return true;      // unknown catalogue: don't call anything missing
			for (const auto& [n, _] : g_catalogue)
				if (n == name)
					return true;
			return false;
		}

		std::mt19937& Rng()
		{
			static std::mt19937 rng{ std::random_device{}() };
			return rng;
		}

		/* Pick the next outfit for a wardrobe.
		 *
		 * Default mode is a SHUFFLE BAG, not a dice roll: every outfit in the
		 * wardrobe is worn once before any of them repeats. Uniform random on a
		 * 4-outfit pool gives you the same dress twice in a row about a quarter of
		 * the time and can leave one unworn for weeks — which reads as "the
		 * randomiser is broken" even though it isn't. The bag holds what is still
		 * unworn this cycle and refills when it empties; a refill avoids handing
		 * back the outfit she is already in, so cycles don't butt up against each
		 * other. "random" mode is kept for anyone who wants true independence.
		 *
		 * Outfits SOES no longer knows are skipped either way, so a stale
		 * membership can never dress someone in nothing. `pool` is mutated (the
		 * bag is state), hence non-const. */
		std::string RollFrom(Pool& pool, const std::string& avoid)
		{
			std::vector<std::string> live;
			for (const auto& n : pool.outfits)
				if (CatalogueHas(n))
					live.push_back(n);
			if (live.empty())
				return "";
			if (live.size() == 1)
				return live.front();

			if (pool.mode == "random") {
				std::vector<std::string> ok = live;
				if (!avoid.empty())
					std::erase(ok, avoid);
				if (ok.empty())
					ok = live;
				std::uniform_int_distribution<std::size_t> d(0, ok.size() - 1);
				return ok[d(Rng())];
			}

			// shuffle bag — drop anything no longer in the wardrobe, then refill
			std::erase_if(pool.bag, [&](const std::string& n) {
				return std::find(live.begin(), live.end(), n) == live.end();
			});
			if (pool.bag.empty()) {
				pool.bag = live;
				std::shuffle(pool.bag.begin(), pool.bag.end(), Rng());
				// a fresh cycle should not open with what she already has on
				if (pool.bag.size() > 1 && !avoid.empty() && pool.bag.front() == avoid)
					std::swap(pool.bag.front(), pool.bag.back());
			}
			const std::string pick = pool.bag.front();
			pool.bag.erase(pool.bag.begin());
			return pick;
		}

		/* Push one assignment at SOES: the base outfit plus every location
		 * override the person has. Returns the outfit actually applied. */
		std::string ApplyAssignment(Config& cfg, Assignment& a, RE::Actor* actor, const std::string& pick)
		{
			if (!actor || pick.empty())
				return "";
			SendEvent(kEvDress, pick, 0.0f, actor);
			for (const auto& ov : a.locationOverrides) {
				// A pinned OUTFIT is the base-SOES behaviour: that one look in
				// that place, every time. A wardrobe rolls fresh instead.
				if (!ov.outfit.empty()) {
					SendEvent(kEvSetLoc, ov.outfit, static_cast<float>(ov.loc), actor);
					continue;
				}
				Pool* p = FindPool(cfg, ov.wardrobeId);
				if (!p) {
					SendEvent(kEvClrLoc, "", static_cast<float>(ov.loc), actor);
					continue;
				}
				const std::string locPick = RollFrom(*p, "");
				if (!locPick.empty())
					SendEvent(kEvSetLoc, locPick, static_cast<float>(ov.loc), actor);
			}
			a.lastOutfit  = pick;
			a.lastRollDay = DaysPassed();
			return pick;
		}
	}

	/* The player's armour as a json array. ONE builder feeds both the view
	 * payload and the file export, so the deck and the portal can never see
	 * different inventories. MAIN THREAD ONLY (walks the player's inventory).
	 * `static`: it is a private helper, not part of the header's contract, so it
	 * must not have external linkage another TU could collide with. */
	static nlohmann::json InventoryJson()
	{
		nlohmann::json items  = nlohmann::json::array();
		auto*          player = RE::PlayerCharacter::GetSingleton();
		if (!player)
			return items;
		auto inv = player->GetInventory([](RE::TESBoundObject& o) { return o.IsArmor(); });
		for (auto& [item, data] : inv) {
			if (!item || data.first <= 0)
				continue;
			auto* armo = item->As<RE::TESObjectARMO>();
			if (!armo)
				continue;
			const char* nm = armo->GetFullName();
			if (!nm || !*nm)
				continue;                        // unnamed / FakeItem rows
			items.push_back(nlohmann::json{
				{ "formId", HexOf(LocalIdOf(armo)) },   // hex, unlike TailorHelper's decimal
				{ "plugin", PluginOf(armo) },
				{ "name", std::string(nm) },
				{ "slot", SlotNameOf(armo) },
				{ "armorRating", static_cast<int>(armo->GetArmorRating()) },
				{ "enchanted", armo->formEnchanting != nullptr },
				{ "count", data.first } });
		}
		return items;
	}

	/* Every armour an actor currently has EQUIPPED. Walks the biped slots rather
	 * than the inventory, because "worn" is a slot question — and de-dupes,
	 * since one piece routinely occupies several slots (a full-body robe covers
	 * body + hands + feet). MAIN THREAD ONLY. */
	std::string WornJson(const std::string& reqJson)
	{
		auto j = nlohmann::json::parse(reqJson, nullptr, false);

		RE::Actor*  actor = nullptr;
		std::string who   = "You";
		if (!j.is_discarded() && j.is_object() && j.contains("formId")) {
			actor = ResolveActor(j.value("formId", std::string("")), j.value("plugin", std::string("")));
			if (!actor)
				return nlohmann::json{ { "ok", false }, { "msg", "That person isn't loaded" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			const char* nm = actor->GetDisplayFullName();
			who = (nm && *nm) ? nm : "They";
		} else {
			actor = RE::PlayerCharacter::GetSingleton();
			if (!actor)
				return nlohmann::json{ { "ok", false }, { "msg", "No player" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		using Slot = RE::BIPED_MODEL::BipedObjectSlot;
		static constexpr Slot kSlots[]{
			Slot::kBody, Slot::kHead, Slot::kHair, Slot::kLongHair, Slot::kCirclet,
			Slot::kHands, Slot::kForearms, Slot::kFeet, Slot::kCalves, Slot::kShield,
			Slot::kAmulet, Slot::kRing, Slot::kEars, Slot::kTail
		};

		nlohmann::json          items = nlohmann::json::array();
		std::vector<RE::FormID> seen;
		for (const auto sl : kSlots) {
			auto* armo = actor->GetWornArmor(sl);
			if (!armo)
				continue;
			const auto id = armo->GetFormID();
			if (std::find(seen.begin(), seen.end(), id) != seen.end())
				continue;                       // a robe fills several slots at once
			seen.push_back(id);
			const char* nm = armo->GetFullName();
			if (!nm || !*nm)
				continue;
			items.push_back(nlohmann::json{
				{ "formId", HexOf(LocalIdOf(armo)) },
				{ "plugin", PluginOf(armo) },
				{ "name", std::string(nm) },
				{ "slot", SlotNameOf(armo) },
				{ "armorRating", static_cast<int>(armo->GetArmorRating()) },
				{ "enchanted", armo->formEnchanting != nullptr } });
		}
		return nlohmann::json{ { "ok", true }, { "who", who }, { "items", items } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	/* Export the player's armour so the portal (and Claude) can see what there is
	 * to build an outfit out of. TailorHelper writes an equivalent file into
	 * Tailor's view dir, but that is Tailor's and only refreshes on a container
	 * event — this one is ours and is written every time the tab opens.
	 * MAIN THREAD ONLY (walks the player's inventory). */
	bool WriteInventoryJson()
	{
		/* Dump what the PLAYER has on beside the inventory, so the phone can offer
		 * the same "bottle this look" shortcut the deck does. Best-effort: a
		 * failure here must never stop the inventory export. */
		{
			auto        wj   = nlohmann::json::parse(WornJson("{}"), nullptr, false);
			const auto  wfile = std::filesystem::path("Data") / "PrismaUI" / "views" / "HotkeyDeck" / "wardrobe-worn.json";
			std::error_code wec;
			std::filesystem::create_directories(wfile.parent_path(), wec);
			std::ofstream wout(wfile, std::ios::binary | std::ios::trunc);
			if (wout.is_open() && !wj.is_discarded())
				wout << wj.dump(2);
		}

		const auto      items = InventoryJson();
		const auto      file  = std::filesystem::path("Data") / "PrismaUI" / "views" / "HotkeyDeck" / "wardrobe-inventory.json";
		std::error_code ec;
		std::filesystem::create_directories(file.parent_path(), ec);
		std::ofstream out(file, std::ios::binary | std::ios::trunc);
		if (!out.is_open()) {
			logger::warn("Wardrobe: could not write {}", file.string());
			return false;
		}
		out << nlohmann::json{ { "version", 1 }, { "items", items } }.dump(2);
		logger::info("Wardrobe: exported {} armour pieces", items.size());
		return true;
	}


	// ================================================= browsing the load order

	/* Every armour in the load order, grouped by the plugin that defines it.
	 * SOES has natives for this, but TESDataHandler already holds the answer, so
	 * we read it directly — no Papyrus round trip, and it works with SOES absent.
	 * Playable armour only: the form array is full of tokens, FX shells and
	 * decapitation props that would drown the real clothes. */
	namespace
	{
		bool UsefulArmor(RE::TESObjectARMO* a)
		{
			if (!a)
				return false;
			const char* nm = a->GetFullName();
			if (!nm || !*nm)
				return false;                      // unnamed = a token, not clothing
			if (a->GetSlotMask() == RE::BIPED_MODEL::BipedObjectSlot::kNone)
				return false;
			using Slot = RE::BIPED_MODEL::BipedObjectSlot;
			const auto mask = static_cast<std::uint32_t>(a->GetSlotMask());
			// decapitation props wear a real name but are never clothing
			if (mask & (static_cast<std::uint32_t>(Slot::kDecapitateHead) |
						static_cast<std::uint32_t>(Slot::kDecapitate)))
				return false;
			return true;
		}
	}

	std::string ArmorModsJson()
	{
		auto* dh = RE::TESDataHandler::GetSingleton();
		if (!dh)
			return R"({"ok":false,"msg":"no data handler","mods":[]})";

		std::map<std::string, int> byPlugin;
		for (auto* a : dh->GetFormArray<RE::TESObjectARMO>())
			if (UsefulArmor(a))
				byPlugin[PluginOf(a)]++;

		// Sort as plain data, then serialise: comparing inside a json array means
		// a dependent `.get<int>()` on an `auto` lambda parameter, which is a
		// portability trap for no benefit.
		std::vector<std::pair<std::string, int>> rows;
		for (const auto& [plugin, n] : byPlugin)
			if (!plugin.empty())
				rows.emplace_back(plugin, n);
		// busiest first — that is where the interesting wardrobes live
		std::sort(rows.begin(), rows.end(), [](const std::pair<std::string, int>& x,
											   const std::pair<std::string, int>& y) {
			return x.second != y.second ? x.second > y.second : Lower(x.first) < Lower(y.first);
		});

		nlohmann::json mods = nlohmann::json::array();
		for (const auto& [plugin, n] : rows)
			mods.push_back(nlohmann::json{ { "plugin", plugin }, { "count", n } });
		return nlohmann::json{ { "ok", true }, { "mods", mods } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string ArmorsForModJson(const std::string& reqJson)
	{
		auto j = nlohmann::json::parse(reqJson, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return R"({"ok":false,"msg":"bad request","items":[]})";
		const std::string plugin = j.value("plugin", std::string(""));
		const std::string q      = Lower(j.value("q", std::string("")));
		// A single mod can hold thousands of armours; cap and say so rather than
		// building a payload the view then has to page through blind.
		const std::size_t cap = static_cast<std::size_t>(j.value("limit", 400));

		auto* dh = RE::TESDataHandler::GetSingleton();
		if (!dh)
			return R"({"ok":false,"msg":"no data handler","items":[]})";

		nlohmann::json items   = nlohmann::json::array();
		std::size_t    matched = 0;
		for (auto* a : dh->GetFormArray<RE::TESObjectARMO>()) {
			if (!UsefulArmor(a))
				continue;
			if (!plugin.empty() && PluginOf(a) != plugin)
				continue;
			const std::string nm = a->GetFullName();
			if (!q.empty() && Lower(nm).find(q) == std::string::npos)
				continue;
			++matched;
			if (items.size() >= cap)
				continue;
			items.push_back(nlohmann::json{
				{ "formId", HexOf(LocalIdOf(a)) },
				{ "plugin", PluginOf(a) },
				{ "name", nm },
				{ "slot", SlotNameOf(a) },
				{ "armorRating", static_cast<int>(a->GetArmorRating()) },
				{ "enchanted", a->formEnchanting != nullptr } });
		}
		return nlohmann::json{ { "ok", true }, { "plugin", plugin }, { "total", matched },
			{ "shown", items.size() }, { "capped", matched > items.size() }, { "items", items } }
			.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	// ================================================ an outfit's actual pieces

	/* What is IN an existing SOES outfit, read out of its own export. SOES stores
	 * each piece as a form string ("0xABCD|Mod.esp"); we resolve it so the view
	 * can show a real name, and flag any piece whose plugin has since gone. */
	std::string OutfitPiecesJson(const std::string& reqJson)
	{
		auto j = nlohmann::json::parse(reqJson, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return R"({"ok":false,"msg":"bad request","items":[]})";
		const std::string want = j.value("name", std::string(""));
		if (want.empty())
			return R"({"ok":false,"msg":"no outfit named","items":[]})";

		const auto      file = SoesDataFile();
		std::error_code ec;
		if (!std::filesystem::exists(file, ec))
			return nlohmann::json{ { "ok", false }, { "msg", "SOES has not exported yet" },
				{ "items", nlohmann::json::array() } }
				.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		std::ifstream in(file, std::ios::binary);
		auto          root = nlohmann::json::parse(in, nullptr, false);
		if (root.is_discarded() || !root.is_object())
			return nlohmann::json{ { "ok", false }, { "msg", "SOES export did not parse" },
				{ "items", nlohmann::json::array() } }
				.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

		// find the outfit under whichever spelling this build uses
		nlohmann::json node;
		for (const char* k : { "outfits", "outfitList", "Outfits" }) {
			if (!root.contains(k))
				continue;
			const auto& n = root[k];
			if (n.is_array()) {
				for (const auto& o : n)
					if (o.is_object() && (o.value("name", o.value("outfitName", std::string(""))) == want))
						node = o;
			} else if (n.is_object() && n.contains(want)) {
				node = n[want];
			}
			if (!node.is_null())
				break;
		}
		if (node.is_null())
			return nlohmann::json{ { "ok", false }, { "msg", "\"" + want + "\" is not in SOES" },
				{ "items", nlohmann::json::array() } }
				.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

		nlohmann::json items = nlohmann::json::array();
		for (const char* k : { "armors", "armorList", "items", "pieces" }) {
			if (!node.contains(k) || !node[k].is_array())
				continue;
			for (const auto& e : node[k]) {
				// "0xABCD|Mod.esp" — SOES's own load-order-proof form string
				std::string fid, plug;
				if (e.is_string()) {
					const std::string sv = e.get<std::string>();
					const auto        bar = sv.find('|');
					fid  = (bar == std::string::npos) ? sv : sv.substr(0, bar);
					plug = (bar == std::string::npos) ? "" : sv.substr(bar + 1);
				} else if (e.is_object()) {
					fid  = e.value("formId", e.value("id", std::string("")));
					plug = e.value("plugin", e.value("mod", std::string("")));
				}
				if (fid.empty())
					continue;
				auto*       armo = ResolveArmor(fid, plug);
				const char* nm   = armo ? armo->GetFullName() : nullptr;
				items.push_back(nlohmann::json{
					{ "formId", fid }, { "plugin", plug },
					{ "name", (nm && *nm) ? std::string(nm) : std::string("(unresolved)") },
					{ "slot", armo ? SlotNameOf(armo) : "Unknown" },
					{ "missing", armo == nullptr } });
			}
			break;
		}
		return nlohmann::json{ { "ok", true }, { "name", want }, { "items", items } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	// ============================================ editing outfits + SOES itself

	std::string RemovePiece(Config& cfg, const std::string& reqJson)
	{
		auto j = nlohmann::json::parse(reqJson, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return R"({"ok":false,"msg":"bad request"})";
		const std::string name = j.value("name", std::string(""));
		auto*             armo = ResolveArmor(j.value("formId", std::string("")),
						 j.value("plugin", std::string("")));
		if (name.empty() || !armo)
			return nlohmann::json{ { "ok", false }, { "msg", "Need an outfit and a piece that resolves" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		SendEvent(kEvDelPc, name, 0.0f, armo);
		RequestCatalogueRefresh();
		const char*       nm  = armo->GetFullName();
		const std::string msg = std::string("Removed ") + ((nm && *nm) ? nm : "that piece") + " from \"" + name + "\"";
		if (cfg.notify)
			Notify(msg);
		return nlohmann::json{ { "ok", true }, { "msg", msg } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string DeleteOutfit(Config& cfg, const std::string& reqJson)
	{
		auto j = nlohmann::json::parse(reqJson, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return R"({"ok":false,"msg":"bad request"})";
		const std::string name = j.value("name", std::string(""));
		if (name.empty())
			return nlohmann::json{ { "ok", false }, { "msg", "No outfit named" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

		SendEvent(kEvDelFit, name, 0.0f, nullptr);

		// Drop everything that pointed at it, or the UI keeps showing a ghost.
		std::erase_if(cfg.outfitMeta, [&](const OutfitMeta& m) { return m.name == name; });
		for (auto& p : cfg.wardrobes) {
			std::erase(p.outfits, name);
			std::erase(p.bag, name);
		}
		for (auto& a : cfg.assignments) {
			if (a.outfit == name)
				a.outfit.clear();
			if (a.lastOutfit == name)
				a.lastOutfit.clear();
			std::erase_if(a.locationOverrides,
				[&](const LocOverride& o) { return o.outfit == name; });
		}
		Tombstone(name);
		RequestCatalogueRefresh();
		const std::string msg = "Deleted \"" + name + "\"";
		if (cfg.notify)
			Notify(msg);
		return nlohmann::json{ { "ok", true }, { "msg", msg } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	// ------------------------------------------------------------- rename ----
	//
	// SOES keys an outfit by its NAME alone, so the rename has to land on BOTH
	// sides in one go or the two disagree forever. Our side is the long half:
	// metadata, every pool list AND its shuffle-bag (the bag holds names too,
	// and a stale one silently rolls nothing), every assignment's chosen outfit,
	// every location override, and the roll history that the "last worn" chip
	// reads.
	std::string RenameOutfit(Config& cfg, const std::string& reqJson)
	{
		auto j = nlohmann::json::parse(reqJson, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return R"({"ok":false,"msg":"bad request"})";
		std::string from = j.value("name", std::string(""));
		std::string to   = j.value("to", std::string(""));
		const auto  trim = [](std::string& s) {
            const auto b = s.find_first_not_of(" \t\r\n");
            const auto e = s.find_last_not_of(" \t\r\n");
            s = (b == std::string::npos) ? std::string() : s.substr(b, e - b + 1);
		};
		trim(from);
		trim(to);
		if (from.empty() || to.empty())
			return nlohmann::json{ { "ok", false }, { "msg", "Need the old name and a new one" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		if (from == to)
			return nlohmann::json{ { "ok", false }, { "msg", "That is already its name" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		// "|" is how the event carries two names in one string field, and it is
		// SOES's own form-key separator. Refuse rather than mangle.
		if (from.find('|') != std::string::npos || to.find('|') != std::string::npos)
			return nlohmann::json{ { "ok", false },
				{ "msg", "Outfit names can't contain \"|\"" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		// SOES's own limit, via GetOutfitNameMaxLength — not readable from here
		// (Papyrus native), so mirror the documented co-save string ceiling.
		if (to.size() > 100)
			return nlohmann::json{ { "ok", false }, { "msg", "That name is too long" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		{
			std::lock_guard lock(g_catMutex);
			const bool haveFrom = std::any_of(g_catalogue.begin(), g_catalogue.end(),
				[&](const auto& p) { return p.first == from; });
			const bool haveTo = std::any_of(g_catalogue.begin(), g_catalogue.end(),
				[&](const auto& p) { return p.first == to; });
			// The catalogue can be stale (SOES exports ~90 s after a change), so
			// a MISSING "from" is only a warning — the executor re-checks. A
			// PRESENT "to" is a hard stop: SOES's RenameOutfit refuses a
			// collision silently, and we would already have renamed our half.
			if (haveTo)
				return nlohmann::json{ { "ok", false },
					{ "msg", "There is already an outfit called \"" + to + "\"" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			if (!haveFrom && !g_catalogue.empty())
				logger::info("Wardrobe: renaming '{}' which the catalogue does not list "
							 "(stale export?) - sending anyway",
					from);
		}

		SendEvent(kEvRename, from + "|" + to, 0.0f, nullptr);

		for (auto& m : cfg.outfitMeta)
			if (m.name == from)
				m.name = to;
		for (auto& p : cfg.wardrobes) {
			for (auto& n : p.outfits)
				if (n == from)
					n = to;
			for (auto& n : p.bag)
				if (n == from)
					n = to;
		}
		for (auto& a : cfg.assignments) {
			if (a.outfit == from)
				a.outfit = to;
			if (a.lastOutfit == from)
				a.lastOutfit = to;
			for (auto& o : a.locationOverrides)
				if (o.outfit == from)
					o.outfit = to;
		}
		// The catalogue everyone DISPLAYS is SOES's export, which is ~90 s
		// behind. Rename it in the cache too, or the old name sits there looking
		// alive — the same complaint that produced the delete tombstones.
		{
			std::lock_guard lock(g_catMutex);
			for (auto& p : g_catalogue)
				if (p.first == from)
					p.first = to;
		}
		RequestCatalogueRefresh();
		const std::string msg = "Renamed to \"" + to + "\"";
		logger::info("Wardrobe: renamed outfit '{}' -> '{}'", from, to);
		if (cfg.notify)
			Notify(msg);
		return nlohmann::json{ { "ok", true }, { "msg", msg }, { "name", to } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	// ---------------------------------------------------------- favourites ----
	std::string SetOutfitFav(Config& cfg, const std::string& reqJson)
	{
		auto j = nlohmann::json::parse(reqJson, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return R"({"ok":false,"msg":"bad request"})";
		const std::string name = j.value("name", std::string(""));
		const bool        on   = j.value("on", true);
		if (name.empty())
			return nlohmann::json{ { "ok", false }, { "msg", "No outfit named" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

		SendEvent(kEvFav, name, on ? 1.0f : 0.0f, nullptr);

		// Mirror into our own metadata so the star survives a restart even
		// though SOES's flag is not in the JSON it exports.
		bool found = false;
		for (auto& m : cfg.outfitMeta)
			if (m.name == name) {
				m.fav = on;
				found = true;
				break;
			}
		if (!found) {
			OutfitMeta m;
			m.name = name;
			m.fav  = on;
			cfg.outfitMeta.push_back(std::move(m));
		}
		logger::info("Wardrobe: favourite '{}' -> {}", name, on);
		return nlohmann::json{ { "ok", true },
			{ "msg", on ? ("\"" + name + "\" is in the quick-swap menu")
						: ("\"" + name + "\" dropped from the quick-swap menu") } }
			.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	// ------------------------------------------------------ system switches ----
	std::string SetSoesOption(Config& cfg, const std::string& reqJson)
	{
		auto j = nlohmann::json::parse(reqJson, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return R"({"ok":false,"msg":"bad request"})";
		const std::string key = j.value("key", std::string(""));
		const bool        on  = j.value("on", true);
		std::string       msg;
		if (key == "quickslot") {
			cfg.soesQuickslot = on;
			msg = on ? "Quick-swap power granted \xE2\x80\x94 it lists your starred outfits"
					 : "Quick-swap power removed";
		} else if (key == "climate") {
			cfg.soesClimate = on;
			msg = on ? "Weather now outranks where she is"
					 : "Where she is now outranks the weather";
		} else {
			return nlohmann::json{ { "ok", false }, { "msg", "Unknown switch" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
		SendEvent(kEvSys, key, on ? 1.0f : 0.0f, nullptr);
		logger::info("Wardrobe: soes option {} -> {}", key, on);
		Notify(msg);
		return nlohmann::json{ { "ok", true }, { "msg", msg } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	// ------------------------------------------------ browsing outfit mods ----
	//
	// BGSOutfit ("OTFT") is a first-class form, so the engine can answer "which
	// plugins define outfits" exactly and instantly. GetFile(0) is the form's
	// ORIGINATING file, which is what SOES's importer wants — a plugin that only
	// overrides someone else's outfit cannot import it.
	namespace
	{
		const char* OutfitSourceFile(RE::BGSOutfit* o)
		{
			if (!o)
				return nullptr;
			auto* f = o->GetFile(0);
			return (f && f->fileName[0]) ? f->fileName : nullptr;
		}
	}

	std::string OutfitModsJson()
	{
		auto* dh = RE::TESDataHandler::GetSingleton();
		if (!dh)
			return R"({"ok":false,"msg":"no data handler","mods":[]})";
		// Insertion-ordered so the list comes back in load order, which is the
		// order Rober reads a load order in.
		std::vector<std::pair<std::string, int>> mods;
		for (auto* o : dh->GetFormArray<RE::BGSOutfit>()) {
			const char* file = OutfitSourceFile(o);
			if (!file)
				continue;
			auto it = std::find_if(mods.begin(), mods.end(),
				[&](const auto& p) { return p.first == file; });
			if (it == mods.end())
				mods.emplace_back(file, 1);
			else
				++it->second;
		}
		nlohmann::json arr = nlohmann::json::array();
		for (const auto& [plugin, count] : mods)
			arr.push_back(nlohmann::json{ { "plugin", plugin }, { "count", count } });
		logger::info("Wardrobe: {} plugin(s) define outfits", arr.size());
		return nlohmann::json{ { "ok", true }, { "mods", std::move(arr) } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string OutfitsForModJson(const std::string& reqJson)
	{
		auto j = nlohmann::json::parse(reqJson, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return R"({"ok":false,"msg":"bad request","outfits":[]})";
		const std::string plugin = j.value("plugin", std::string(""));
		std::string       q      = j.value("q", std::string(""));
		std::transform(q.begin(), q.end(), q.begin(),
			[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
		auto* dh = RE::TESDataHandler::GetSingleton();
		if (plugin.empty() || !dh)
			return R"({"ok":false,"msg":"no plugin named","outfits":[]})";

		nlohmann::json arr = nlohmann::json::array();
		for (auto* o : dh->GetFormArray<RE::BGSOutfit>()) {
			const char* file = OutfitSourceFile(o);
			if (!file || plugin != file)
				continue;
			// The EditorID IS the import key — SOES's AddOutfitFromModToOutfitList
			// takes (modName, formEditorID). An outfit with none cannot be named
			// to it, so it is listed as unimportable rather than silently dropped.
			const char*       ed  = o->GetFormEditorID();
			const std::string eid = (ed && *ed) ? ed : std::string();
			if (!q.empty()) {
				std::string hay = eid;
				std::transform(hay.begin(), hay.end(), hay.begin(),
					[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
				if (hay.find(q) == std::string::npos)
					continue;
			}
			arr.push_back(nlohmann::json{ { "editorId", eid },
				{ "parts", static_cast<int>(o->outfitItems.size()) },
				{ "formId", HexOf(ActorIdentity::LocalIdOf(o)) } });
		}
		return nlohmann::json{ { "ok", true }, { "plugin", plugin },
			{ "outfits", std::move(arr) } }
			.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string ImportModOutfits(const std::string& reqJson)
	{
		auto j = nlohmann::json::parse(reqJson, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return R"({"ok":false,"msg":"bad request"})";
		const std::string plugin   = j.value("plugin", std::string(""));
		const std::string editorId = j.value("editorId", std::string(""));
		if (plugin.empty())
			return nlohmann::json{ { "ok", false }, { "msg", "No plugin named" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		// one outfit, or every outfit the plugin defines
		SendEvent(kEvImport, editorId.empty() ? plugin : (plugin + "|" + editorId), 0.0f, nullptr);
		RequestCatalogueRefresh();
		const std::string msg = editorId.empty()
			? ("Importing every outfit from " + plugin)
			: ("Importing " + editorId + " from " + plugin);
		Notify(msg);
		return nlohmann::json{ { "ok", true }, { "msg", msg } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string SetInventoryMode(const std::string& reqJson)
	{
		auto j = nlohmann::json::parse(reqJson, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return R"({"ok":false,"msg":"bad request"})";
		const std::string who  = j.value("who", std::string("npc"));
		const int         mode = j.value("mode", 2);
		if (who != "player" && who != "npc")
			return nlohmann::json{ { "ok", false }, { "msg", "who must be player or npc" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		if (mode != 1 && mode != 2)
			return nlohmann::json{ { "ok", false }, { "msg", "mode must be 1 (automatic) or 2 (immersive)" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		SendEvent(kEvInvMod, who, static_cast<float>(mode), nullptr);
		const std::string msg = std::string(who == "player" ? "Your" : "NPC") + " outfits: " +
			(mode == 1 ? "conjure missing pieces" : "only what they already own");
		Notify(msg);
		return nlohmann::json{ { "ok", true }, { "msg", msg } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string SetSoesEnabled(const std::string& reqJson)
	{
		auto       j  = nlohmann::json::parse(reqJson, nullptr, false);
		const bool on = (!j.is_discarded() && j.is_object()) ? j.value("on", true) : true;
		SendEvent(kEvEnable, "", on ? 1.0f : 0.0f, nullptr);
		const std::string msg = on ? "Outfit system ON" : "Outfit system OFF \xE2\x80\x94 nobody is managed";
		Notify(msg);
		return nlohmann::json{ { "ok", true }, { "msg", msg } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string RefreshAll()
	{
		SendEvent(kEvRefAll, "", 0.0f, nullptr);
		return nlohmann::json{ { "ok", true }, { "msg", "Re-dressing everyone tracked" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string ResetAutoSwitch()
	{
		SendEvent(kEvReset, "", 0.0f, nullptr);
		return nlohmann::json{ { "ok", true }, { "msg", "Auto-switch state cleared" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	void Init()
	{
		LoadCatalogue();
		logger::info("Wardrobe: init (catalogue {})", g_catOk ? "loaded" : "not exported yet");
	}

	// ------------------------------------------------------------- persistence

	nlohmann::json ToJson(const Config& c)
	{
		nlohmann::json cats = nlohmann::json::array();
		for (const auto& x : c.categories)
			cats.push_back(CatJson(x));
		nlohmann::json metas = nlohmann::json::array();
		for (const auto& x : c.outfitMeta)
			metas.push_back(MetaJson(x));
		nlohmann::json pools = nlohmann::json::array();
		for (const auto& x : c.wardrobes)
			pools.push_back(PoolJson(x));
		nlohmann::json assigns = nlohmann::json::array();
		for (const auto& x : c.assignments)
			assigns.push_back(AssignJson(x));
		nlohmann::json crops = nlohmann::json::object();
		for (const auto& [file, x] : c.imageCrops)
			crops[file] = nlohmann::json{ { "z", x.z }, { "x", x.x }, { "y", x.y } };
		return nlohmann::json{ { "categories", cats }, { "outfitMeta", metas },
			{ "wardrobes", pools }, { "assignments", assigns },
			{ "imageCrops", std::move(crops) },
			{ "settings", { { "enabled", c.enabled }, { "notify", c.notify },
				{ "uiScale", c.uiScale },
				{ "soesQuickslot", c.soesQuickslot }, { "soesClimate", c.soesClimate } } } };
	}

	// NOTE the `out` contract for imageCrops: a payload with NO "imageCrops" key
	// KEEPS whatever `out` already held. That is what lets wdSave — which the
	// view sends carrying categories/outfitMeta/wardrobes/assignments/settings
	// and nothing else — round-trip the slice without wiping a map it does not
	// own. Every other field is still replaced wholesale, as it always was.
	void FromJson(const nlohmann::json& j, Config& out)
	{
		Config c;
		c.imageCrops = out.imageCrops;
		// Same `out`-preserving contract as imageCrops, for the same reason: the
		// view's wdSave carries neither, and a payload that omits a C++-owned
		// field must never be read as "set it back to the default".
		c.soesQuickslot = out.soesQuickslot;
		c.soesClimate   = out.soesClimate;
		if (j.is_object() && j.contains("imageCrops") && j["imageCrops"].is_object()) {
			c.imageCrops.clear();
			for (const auto& [file, v] : j["imageCrops"].items()) {
				if (c.imageCrops.size() >= kMaxImageCrops)
					break;
				if (!ValidImageFileName(file) || !v.is_object())
					continue;
				// is_number() rather than value<double>(): hotkeys.json is
				// hand-editable, and value() on a string THROWS type_error —
				// inside config load that is a lost config, not a bad crop.
				const auto num = [&v](const char* k, double d) {
					return (v.contains(k) && v[k].is_number()) ? v[k].get<double>() : d;
				};
				ImageCrop x;
				x.z = num("z", 1.0);
				x.x = num("x", 0.0);
				x.y = num("y", 0.0);
				if (ClampImageCrop(x))
					c.imageCrops[file] = x;
			}
		}
		if (j.is_object()) {
			if (j.contains("categories") && j["categories"].is_array())
				for (const auto& x : j["categories"]) {
					auto v = CatFrom(x);
					if (!v.id.empty())
						c.categories.push_back(std::move(v));
				}
			if (j.contains("outfitMeta") && j["outfitMeta"].is_array())
				for (const auto& x : j["outfitMeta"]) {
					auto v = MetaFrom(x);
					if (!v.name.empty())
						c.outfitMeta.push_back(std::move(v));
				}
			if (j.contains("wardrobes") && j["wardrobes"].is_array())
				for (const auto& x : j["wardrobes"]) {
					auto v = PoolFrom(x);
					if (!v.id.empty())
						c.wardrobes.push_back(std::move(v));
				}
			if (j.contains("assignments") && j["assignments"].is_array())
				for (const auto& x : j["assignments"]) {
					auto v = AssignFrom(x);
					if (!v.formId.empty())
						c.assignments.push_back(std::move(v));
				}
			if (j.contains("settings") && j["settings"].is_object()) {
				c.enabled = j["settings"].value("enabled", true);
				c.notify  = j["settings"].value("notify", true);
				// Clamped on the way IN, same as FollowerConfig does: a hand-edited
				// hotkeys.json must not be able to hand the view a 40x tab.
				const double sc = j["settings"].value("uiScale", 1.0);
				c.uiScale       = (sc > 0.0) ? std::clamp(sc, 0.6, 1.6) : 1.0;
				// C++-owned mirrors (see wardrobe.h). Defaulted to whatever `out`
				// already held rather than to false, so the same `out`-preserving
				// contract imageCrops relies on covers these too: a payload
				// without them KEEPS them, and the view's wdSave never sends them.
				c.soesQuickslot = j["settings"].value("soesQuickslot", out.soesQuickslot);
				c.soesClimate   = j["settings"].value("soesClimate", out.soesClimate);
			}
		}
		// One line, once, so "are my pills actually persisted?" is a log read
		// rather than an investigation — MetaJson/PoolJson drop anything they do
		// not know about, which is exactly how a view-only tag field would have
		// silently evaporated on the next save.
		{
			std::size_t tags = 0, owners = 0;
			for (const auto& m : c.outfitMeta) { tags += m.tags.size(); owners += m.forNpcs.size(); }
			for (const auto& w : c.wardrobes) { tags += w.tags.size(); owners += w.forNpcs.size(); }
			if (tags || owners)
				logger::info("wardrobe: outfit-tags loaded - {} tag(s), {} owner pill(s)", tags, owners);
		}
		out = std::move(c);
	}

	bool MergeViewSlice(const std::string& viewJson, Config& cfg)
	{
		return MergeViewSlice(viewJson, cfg, nullptr);
	}

	bool MergeViewSlice(const std::string& viewJson, Config& cfg,
		std::vector<std::pair<std::string, std::string>>* activated)
	{
		auto j = nlohmann::json::parse(viewJson, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return false;

		// Which assignments were ACTIVE before this merge, so the caller can be
		// told which ones just turned on and auto-track them — assigning an
		// outfit MEANS "SOES manages her" (Rober, 2026-08-03); the separate
		// Track click was the step everyone forgot.
		std::vector<std::string> wasActive;
		if (activated)
			for (const auto& a : cfg.assignments)
				if (a.mode == "outfit" || a.mode == "wardrobe")
					wasActive.push_back(Lower(ActorKey(a.formId, a.plugin)));

		// Remember the C++-owned roll bookkeeping — the view echoes it back but
		// must never be the authority on when someone last changed clothes.
		struct Roll
		{
			double      day;
			std::string outfit;
		};
		std::vector<std::pair<std::string, Roll>> keep;
		for (const auto& a : cfg.assignments)
			keep.emplace_back(ActorKey(a.formId, a.plugin), Roll{ a.lastRollDay, a.lastOutfit });

		Config next;
		// Seed the C++-owned crop map BEFORE the parse: FromJson preserves what
		// its `out` already holds when the payload omits "imageCrops", and the
		// view's wdSave always omits it. Without this line every edit to a note,
		// a category or a cadence would silently wipe every outfit crop.
		next.imageCrops = cfg.imageCrops;
		// Ditto the two SOES mirrors: the view renders them but never owns them,
		// so a wdSave (which omits them) must not switch the quick-swap power off.
		next.soesQuickslot = cfg.soesQuickslot;
		next.soesClimate   = cfg.soesClimate;
		FromJson(j, next);

		for (auto& a : next.assignments) {
			// The view sends back the identity it was RENDERED with — FO's runtime
			// FormID and an empty plugin. Store the durable pair instead, or the
			// next load order silently orphans the assignment (Elana, 2026-08-02).
			ActorIdentity::CanonicaliseActor(a.formId, a.plugin, a.name);
			const auto key = ActorKey(a.formId, a.plugin);
			for (const auto& [k, r] : keep)
				if (k == key) {
					a.lastRollDay = r.day;
					a.lastOutfit  = r.outfit;
					break;
				}
		}
		cfg = std::move(next);
		if (activated)
			for (const auto& a : cfg.assignments) {
				if (a.mode != "outfit" && a.mode != "wardrobe")
					continue;
				const auto ky = Lower(ActorKey(a.formId, a.plugin));
				if (std::find(wasActive.begin(), wasActive.end(), ky) == wasActive.end())
					activated->emplace_back(a.formId, a.plugin);
			}

		return true;
	}

	// ------------------------------------------------ outfit-photo crops

	// THE one place the invariant lives on this side; wardrobe-pane.js
	// clampCrop() is its twin and the two must agree, because either side can be
	// the last to touch a value and hotkeys.json is hand-editable.
	bool ClampImageCrop(ImageCrop& c)
	{
		const auto finite = [](double v) { return std::isfinite(v); };
		if (!finite(c.z))
			c.z = 1.0;
		c.z = std::clamp(c.z, 1.0, 4.0);
		// At zoom z the picture overhangs the tile by (z-1)/2 a side; a pan past
		// that would show the well behind it. z=1 therefore allows no pan at
		// all, which is correct — there is nothing to pan into.
		const double lim = (c.z - 1.0) / 2.0;
		if (!finite(c.x))
			c.x = 0.0;
		if (!finite(c.y))
			c.y = 0.0;
		c.x = std::clamp(c.x, -lim, lim);
		c.y = std::clamp(c.y, -lim, lim);
		// Same 4dp the view rounds to, so a value that round-trips through JSON
		// compares equal to the one the editor sent.
		const auto r4 = [](double v) { return std::round(v * 1e4) / 1e4; };
		c.z = r4(c.z);
		c.x = r4(c.x);
		c.y = r4(c.y);
		return !(c.z == 1.0 && c.x == 0.0 && c.y == 0.0);
	}

	bool ValidImageFileName(const std::string& s)
	{
		if (s.empty() || s.size() > 160 || s == "." || s == "..")
			return false;
		return s.find('/') == std::string::npos && s.find('\\') == std::string::npos &&
		       s.find(':') == std::string::npos;
	}

	bool ApplyCropSave(Config& cfg, const std::string& reqJson)
	{
		const auto j = nlohmann::json::parse(reqJson, nullptr, false);
		if (j.is_discarded() || !j.is_object()) {
			logger::error("wdCropSave: rejected invalid payload");
			return false;
		}
		const auto file = j.value("file", std::string());
		if (!ValidImageFileName(file)) {
			logger::error("wdCropSave: refused file name '{}'", file);
			return false;
		}
		const bool clear = j.value("clear", false);
		ImageCrop  c;
		if (!clear) {
			const auto num = [&j](const char* k, double d) {
				return (j.contains(k) && j[k].is_number()) ? j[k].get<double>() : d;
			};
			c.z = num("z", 1.0);
			c.x = num("x", 0.0);
			c.y = num("y", 0.0);
		}
		// An identity crop and an explicit clear are the same instruction, so
		// the view says `clear` outright and neither side has to guess.
		const bool keep = !clear && ClampImageCrop(c);
		if (keep) {
			// Only refuse a NEW key past the ceiling: overwriting a crop that is
			// already there must always work, however full the map is.
			if (cfg.imageCrops.size() < kMaxImageCrops || cfg.imageCrops.count(file))
				cfg.imageCrops[file] = c;
		} else {
			cfg.imageCrops.erase(file);
		}
		logger::info("outfit crop saved: {} z={:.3f} x={:.3f} y={:.3f} keep={}",
			file, c.z, c.x, c.y, keep);
		return true;
	}

	bool PruneImageCrops(Config& cfg, const std::filesystem::path& dir)
	{
		const bool dropped = PruneCropMap(cfg.imageCrops, dir);
		// Its own line, not folded into PruneCropMap's: this exact literal is
		// the `outfit-crop-prune` build marker, and a marker only protects a
		// feature while the string it names still exists in the binary.
		if (dropped)
			logger::info("outfit crops pruned: trimmed against {}", dir.filename().string());
		return dropped;
	}

	bool PruneCropMap(std::map<std::string, ImageCrop>& crops, const std::filesystem::path& dir)
	{
		// Folded to lower case because Windows compares names that way and a
		// crop keyed `WD-Gown.PNG` must recognise `wd-gown.png` on disk as its
		// file.
		const auto fold = [](std::string s) {
			std::transform(s.begin(), s.end(), s.begin(),
				[](unsigned char ch) { return static_cast<char>(std::tolower(ch)); });
			return s;
		};
		std::unordered_set<std::string> live;
		std::error_code                 ec;
		for (std::filesystem::directory_iterator it(dir, ec), end; !ec && it != end; it.increment(ec)) {
			std::error_code fec;
			if (!it->is_regular_file(fec))
				continue;
			live.insert(fold(it->path().filename().string()));
		}
		if (live.empty())
			return false;   // see the header: an empty read is never a mandate to delete
		std::size_t dropped = 0;
		for (auto it = crops.begin(); it != crops.end();) {
			if (live.count(fold(it->first))) {
				++it;
			} else {
				it = crops.erase(it);
				++dropped;
			}
		}
		if (dropped)
			logger::info("photo crops pruned: {} whose picture is gone (dir {})", dropped,
				dir.filename().string());
		return dropped > 0;
	}

	std::string CropsJson(const Config& c)
	{
		nlohmann::json crops = nlohmann::json::object();
		for (const auto& [file, x] : c.imageCrops)
			crops[file] = nlohmann::json{ { "z", x.z }, { "x", x.x }, { "y", x.y } };
		// .dump(-1, ' ', false, nlohmann::json::error_handler_t::replace), never the json itself — PushToView takes a std::string and
		// the implicit conversion compiles, then throws type_error.302 at
		// runtime inside a PrismaUI callback, which is a hard CTD.
		return nlohmann::json{ { "crops", std::move(crops) } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	// --------------------------------------------------------- SOES catalogue

	bool CatalogueAvailable()
	{
		std::lock_guard lock(g_catMutex);
		return g_catOk;
	}

	void RequestCatalogueRefresh()
	{
		g_catPending = true;
		SendEvent(kEvExport, "", 0.0f, nullptr);
	}

	std::uint64_t CatalogueStamp()
	{
		std::error_code ec;
		const auto      f = SoesDataFile();
		if (!std::filesystem::exists(f, ec))
			return 0;
		const auto t = std::filesystem::last_write_time(f, ec);
		if (ec)
			return 0;
		return static_cast<std::uint64_t>(t.time_since_epoch().count());
	}

	/* SOES serialises protobuf -> JSON, and the exact key names are not pinned
	 * by its docs, so this reader is deliberately tolerant: it accepts several
	 * plausible spellings and simply reports "no catalogue" if none match, which
	 * the UI already renders as a banner. Confirm the real shape from one
	 * in-game export and tighten if you like — but keep it forgiving. */
	// The catalogue WITH resolved piece names and slots, for the Deck Portal —
	// the phone cannot resolve a FormID, so "what is IN this outfit" needs the
	// game to write it down. Sits beside the inventory export and refreshes with
	// the cache. MAIN THREAD (resolves forms); takes the already-parsed SOES root.
	static void WriteCatalogueJson(const nlohmann::json& root)
	{
		nlohmann::json outfits = nlohmann::json::array();
		const auto     addOutfit = [&](const std::string& name, const nlohmann::json& node) {
			if (name.empty())
				return;
			if (g_deletedNames.count(name))   // deleted; the export just hasn't caught up
				return;
			nlohmann::json items = nlohmann::json::array();
			if (node.is_object())
				for (const char* ak : { "armors", "armorList", "items", "pieces" }) {
					if (!node.contains(ak) || !node[ak].is_array())
						continue;
					for (const auto& e : node[ak]) {
						std::string fid, plug;
						if (e.is_string()) {
							const std::string sv  = e.get<std::string>();
							const auto        bar = sv.find('|');
							fid  = (bar == std::string::npos) ? sv : sv.substr(0, bar);
							plug = (bar == std::string::npos) ? "" : sv.substr(bar + 1);
						} else if (e.is_object()) {
							fid  = e.value("formId", e.value("id", std::string("")));
							plug = e.value("plugin", e.value("mod", std::string("")));
						}
						if (fid.empty())
							continue;
						auto*       armo = ResolveArmor(fid, plug);
						const char* nm   = armo ? armo->GetFullName() : nullptr;
						items.push_back(nlohmann::json{
							{ "formId", fid }, { "plugin", plug },
							{ "name", (nm && *nm) ? std::string(nm) : std::string("") },
							{ "slot", armo ? SlotNameOf(armo) : "Unknown" },
							{ "missing", armo == nullptr } });
					}
					break;
				}
			outfits.push_back(nlohmann::json{
				{ "name", name },
				{ "fav", node.is_object() && node.value("isFavorite", false) },
				{ "items", std::move(items) } });
		};
		for (const char* k : { "outfits", "outfitList", "Outfits" }) {
			if (!root.contains(k))
				continue;
			const auto& n = root[k];
			if (n.is_array()) {
				for (const auto& o : n) {
					if (o.is_string())
						addOutfit(o.get<std::string>(), nlohmann::json());
					else if (o.is_object())
						addOutfit(o.value("name", o.value("outfitName", std::string(""))), o);
				}
			} else if (n.is_object()) {
				for (auto it = n.begin(); it != n.end(); ++it)
					addOutfit(it.key(), it.value());
			}
			break;
		}
		const auto      file = std::filesystem::path("Data") / "PrismaUI" / "views" / "HotkeyDeck" / "wardrobe-catalogue.json";
		std::error_code ec;
		std::filesystem::create_directories(file.parent_path(), ec);
		auto tmp = file;
		tmp += ".tmp";
		{
			std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
			if (!out.is_open())
				return;
			out << nlohmann::json{ { "version", 1 }, { "outfits", std::move(outfits) } }.dump(2);
		}
		std::filesystem::rename(tmp, file, ec);
		if (!ec)
			logger::info("Wardrobe: catalogue exported with names for the portal");
	}

	// Make a deleted outfit disappear NOW: out of the cached catalogue, out of
	// the portal's named export — instead of lingering until SOES's ~90 s
	// export cycle. The tombstone itself is cleared by LoadCatalogue the first
	// time a fresh export no longer carries the name.
	static void Tombstone(const std::string& name)
	{
		{
			std::lock_guard lock(g_catMutex);
			g_deletedNames.insert(name);
			std::erase_if(g_catalogue, [&](const auto& c) { return c.first == name; });
		}
		logger::info("Wardrobe: tombstoned '{}' until SOES's export catches up", name);
		const auto      src = SoesDataFile();
		std::error_code ec;
		if (!std::filesystem::exists(src, ec))
			return;
		std::ifstream in(src, std::ios::binary);
		auto          root = nlohmann::json::parse(in, nullptr, false);
		if (!root.is_discarded() && root.is_object()) {
			std::lock_guard lock(g_catMutex);
			WriteCatalogueJson(root);
		}
	}

	bool LoadCatalogue()
	{
		const auto      file = SoesDataFile();
		std::error_code ec;
		if (!std::filesystem::exists(file, ec)) {
			std::lock_guard lock(g_catMutex);
			g_catOk = false;
			return false;
		}
		std::ifstream in(file, std::ios::binary);
		if (!in.is_open())
			return false;
		auto j = nlohmann::json::parse(in, nullptr, false);
		if (j.is_discarded() || !j.is_object()) {
			logger::warn("Wardrobe: SOES export did not parse");
			std::lock_guard lock(g_catMutex);
			g_catOk = false;
			return false;
		}

		std::vector<std::pair<std::string, int>> cat;
		std::vector<std::string>                 tracked;
		std::vector<std::pair<std::string, std::string>> wearing;

		auto readOutfits = [&](const nlohmann::json& arr) {
			for (const auto& o : arr) {
				if (o.is_string()) {
					cat.emplace_back(o.get<std::string>(), 0);
					continue;
				}
				if (!o.is_object())
					continue;
				std::string name = o.value("name", o.value("outfitName", std::string("")));
				if (name.empty())
					continue;
				int n = 0;
				for (const char* k : { "armors", "armorList", "items", "pieces" })
					if (o.contains(k) && o[k].is_array()) {
						n = static_cast<int>(o[k].size());
						break;
					}
				cat.emplace_back(std::move(name), n);
			}
		};
		for (const char* k : { "outfits", "outfitList", "Outfits" })
			if (j.contains(k) && j[k].is_array()) {
				readOutfits(j[k]);
				break;
			}
		// object-keyed form: { "outfits": { "Name": {...} } }
		for (const char* k : { "outfits", "Outfits" })
			if (cat.empty() && j.contains(k) && j[k].is_object())
				for (auto it = j[k].begin(); it != j[k].end(); ++it) {
					int n = (it.value().is_object() && it.value().contains("armors") && it.value()["armors"].is_array())
						? static_cast<int>(it.value()["armors"].size())
						: 0;
					cat.emplace_back(it.key(), n);
				}

		for (const char* k : { "actorOutfitAssignments", "actors", "actorAssignments" })
			if (j.contains(k)) {
				const auto& node = j[k];
				if (node.is_object())
					for (auto it = node.begin(); it != node.end(); ++it) {
						tracked.push_back(it.key());
						if (it.value().is_object()) {
							const std::string cur = it.value().value("currentOutfit",
								it.value().value("selectedOutfit", std::string("")));
							if (!cur.empty())
								wearing.emplace_back(it.key(), cur);
						} else if (it.value().is_string()) {
							wearing.emplace_back(it.key(), it.value().get<std::string>());
						}
					}
				else if (node.is_array())
					for (const auto& a : node) {
						if (!a.is_object())
							continue;
						const std::string id = a.value("actor", a.value("formString", std::string("")));
						if (id.empty())
							continue;
						tracked.push_back(id);
						const std::string cur = a.value("currentOutfit", a.value("selectedOutfit", std::string("")));
						if (!cur.empty())
							wearing.emplace_back(id, cur);
					}
				break;
			}

		std::sort(cat.begin(), cat.end(),
			[](const auto& a, const auto& b) { return Lower(a.first) < Lower(b.first); });

		std::lock_guard lock(g_catMutex);
		// deleted-outfit tombstones: filter names SOES's export still carries;
		// a name the export has finally dropped clears its tombstone.
		for (auto it = g_deletedNames.begin(); it != g_deletedNames.end();) {
			const bool still = std::any_of(cat.begin(), cat.end(),
				[&](const auto& c) { return c.first == *it; });
			if (still) {
				std::erase_if(cat, [&](const auto& c) { return c.first == *it; });
				++it;
			} else {
				it = g_deletedNames.erase(it);
			}
		}
		g_catalogue = std::move(cat);
		g_tracked   = std::move(tracked);
		g_wearing   = std::move(wearing);
		g_catOk     = !g_catalogue.empty();
		g_catPending = false;                 // the answer arrived
		logger::info("Wardrobe: catalogue {} outfits, {} tracked actors", g_catalogue.size(), g_tracked.size());
		if (g_catOk)
			WriteCatalogueJson(j);
		return g_catOk;
	}

	// ------------------------------------------------------------- view payloads

	namespace
	{
		// SOES stores an actor as "0xABCD|Mod.esp"; so do we, so the two agree.
		bool TrackedKey(const std::string& key)
		{
			std::lock_guard lock(g_catMutex);
			const auto      want = Lower(key);
			for (const auto& t : g_tracked)
				if (Lower(t) == want)
					return true;
			return false;
		}
		std::string WearingKey(const std::string& key)
		{
			std::lock_guard lock(g_catMutex);
			const auto      want = Lower(key);
			for (const auto& [k, v] : g_wearing)
				if (Lower(k) == want)
					return v;
			return "";
		}

		nlohmann::json SoesJson()
		{
			std::lock_guard lock(g_catMutex);
			nlohmann::json  arr = nlohmann::json::array();
			for (const auto& [name, n] : g_catalogue)
				arr.push_back(nlohmann::json{ { "name", name }, { "items", n } });
			return nlohmann::json{ { "available", g_catOk }, { "outfits", arr },
				{ "tracked", g_tracked }, { "pending", g_catPending.load() } };
		}

		/* An outfit you just MADE, before SOES has confirmed it exists.
		 *
		 * The list above is SOES's export and nothing else, and SOES answers a
		 * refresh request through Papyrus on its own schedule — measured at ~90 s
		 * on this save. So building "Necromant" wrote the outfit, logged it, and
		 * then showed the player nothing at all for a minute and a half, which
		 * reads exactly like the build silently failed (reported 2026-08-02).
		 *
		 * BuildOutfit already adds an OutfitMeta row the moment it succeeds, so
		 * the name is known here. Merge any meta name the catalogue has not caught
		 * up with, flagged `pending` so the view can say "confirming…" rather than
		 * claim a piece count it cannot know yet. A deleted outfit cannot come
		 * back this way: DeleteOutfit erases its meta row in the same breath. */
		void MergePendingOutfits(nlohmann::json& soes, const Config& c)
		{
			if (!soes.contains("outfits") || !soes["outfits"].is_array())
				return;
			for (const auto& m : c.outfitMeta) {
				if (m.name.empty())
					continue;
				const bool known = std::any_of(soes["outfits"].begin(), soes["outfits"].end(),
					[&](const nlohmann::json& o) { return o.value("name", std::string("")) == m.name; });
				if (known)
					continue;
				soes["outfits"].push_back(nlohmann::json{
					{ "name", m.name }, { "items", 0 }, { "pending", true } });
			}
		}

		/* Read Tailor's own per-NPC assignment file so we can flag a clash. Tailor
		 * is a SECOND live dressing engine (assignments.json, per-situation) and an
		 * NPC managed by both will fight over their clothes. Read-only, always:
		 * consolidating is Rober's call, never ours. */
		std::vector<std::string> TailorAssignedKeys()
		{
			std::vector<std::string> out;
			const auto file = std::filesystem::path("Data") / "SKSE" / "Plugins" / "Tailor" / "assignments.json";
			std::error_code ec;
			if (!std::filesystem::exists(file, ec))
				return out;
			std::ifstream in(file, std::ios::binary);
			if (!in.is_open())
				return out;
			auto j = nlohmann::json::parse(in, nullptr, false);
			if (j.is_discarded() || !j.is_object() || !j.contains("assignments") || !j["assignments"].is_array())
				return out;
			for (const auto& a : j["assignments"]) {
				if (!a.is_object())
					continue;
				const std::string id  = a.value("actorFormId", std::string(""));
				const std::string plg = a.value("actorPlugin", std::string(""));
				if (!id.empty())
					out.push_back(Lower(ActorKey(id, plg)));
			}
			return out;
		}

		/* The roster. FO order first, then anyone we hold an assignment for who
		 * FO no longer lists. */
		nlohmann::json NpcsJson(const Config& cfg, const std::string& foStateJson)
		{
			nlohmann::json arr = nlohmann::json::array();
			const auto     clash = TailorAssignedKeys();

			auto emit = [&](const std::string& formId, const std::string& plugin,
							const std::string& name, const std::string& portrait) {
				const std::string key = ActorKey(formId, plugin);
				const std::string lk  = Lower(key);
				// The row's DURABLE identity, beside the runtime one. The view
				// matches assignments (stored canonically since the identity
				// repair) against rows (runtime ids, kept for portraits and the
				// crosshair snapshot) — and those two spellings NEVER matched, so
				// saving Elana's assignment worked in C++ and then the sheet
				// could not find its own row again: every reopen showed "not
				// managed", re-created a duplicate, and the merge warned. The
				// canonical key is what both sides now compare on.
				std::string dId = formId, dPlg = plugin, canon = lk;
				if (ActorIdentity::DurableOf(ActorIdentity::Resolve(formId, plugin), dId, dPlg))
					canon = Lower(ActorKey(dId, dPlg));
				arr.push_back(nlohmann::json{
					{ "formId", formId }, { "plugin", plugin }, { "name", name },
					{ "key", canon },
					{ "portrait", portrait },
					{ "tracked", TrackedKey(key) },
					{ "wearing", WearingKey(key) },
					{ "conflict", std::find(clash.begin(), clash.end(), lk) != clash.end() } });
			};

			std::vector<std::string> seen;
			const auto env = nlohmann::json::parse(foStateJson, nullptr, false);
			if (!env.is_discarded() && env.is_object()) {
				const nlohmann::json& st =
					(env.contains("state") && env["state"].is_object()) ? env["state"] : env;
				if (st.contains("categories") && st["categories"].is_array())
					for (const auto& cat : st["categories"]) {
						if (!cat.is_object() || !cat.contains("members") || !cat["members"].is_array())
							continue;
						for (const auto& m : cat["members"]) {
							if (!m.is_object())
								continue;
							const std::string id = m.value("formId", std::string(""));
							if (id.empty())
								continue;
							std::string plg = m.value("plugin", std::string(""));
							// FO's Deck API carries no plugin at all. Fill it from the
							// live form so the row that leaves here is an unambiguous
							// pair; `formId` deliberately stays the runtime id the view
							// already matches portraits and the crosshair snapshot on.
							if (plg.empty()) {
								std::string dId, dPlg;
								if (ActorIdentity::DurableOf(ActorIdentity::Resolve(id, ""), dId, dPlg))
									plg = dPlg;
							}
							const std::string key = ActorKey(id, plg);
							if (std::find(seen.begin(), seen.end(), key) != seen.end())
								continue;
							seen.push_back(key);
							emit(id, plg, m.value("name", std::string("")), m.value("portrait", std::string("")));
						}
					}
			}
			// Anyone we hold an assignment for whom FO no longer lists. The `seen`
			// test is on the IDENTITY, so a stored row and its FO row collapse even
			// when they are spelled differently — which is what put Elana Darkfire
			// in this list twice, once permanently unresolvable.
			for (const auto& a : cfg.assignments) {
				const std::string key = ActorKey(a.formId, a.plugin);
				if (std::find(seen.begin(), seen.end(), key) != seen.end())
					continue;
				seen.push_back(key);
				emit(a.formId, a.plugin, a.name, "");
			}
			return arr;
		}
	}

	// ------------------------------------------------------ identity repair ---

	bool RepairIdentities(Config& cfg, const std::string& foStateJson)
	{
		bool changed = false;

		// Everyone Follower Organizer can see RIGHT NOW, by every name she goes
		// by, with her durable identity. FO is the only authority that can rescue
		// a row whose stored FormID no longer addresses anybody: the id is dead,
		// the name is not.
		struct Live
		{
			std::string name, formId, plugin;
		};
		std::vector<Live> live;
		const auto        env = nlohmann::json::parse(foStateJson, nullptr, false);
		if (!env.is_discarded() && env.is_object()) {
			const nlohmann::json& st =
				(env.contains("state") && env["state"].is_object()) ? env["state"] : env;
			if (st.contains("categories") && st["categories"].is_array())
				for (const auto& cat : st["categories"]) {
					if (!cat.is_object() || !cat.contains("members") || !cat["members"].is_array())
						continue;
					for (const auto& m : cat["members"]) {
						if (!m.is_object())
							continue;
						const std::string id = m.value("formId", std::string(""));
						if (id.empty())
							continue;
						std::string dId, dPlg;
						if (!ActorIdentity::DurableOf(
								ActorIdentity::Resolve(id, m.value("plugin", std::string(""))), dId, dPlg))
							continue;   // she does not resolve either — no help here
						for (const char* k : { "name", "original", "override" }) {
							auto nm = m.value(k, std::string(""));
							if (!nm.empty())
								live.push_back(Live{ Lower(nm), dId, dPlg });
						}
					}
				}
		}

		// Two people under one name make the name useless as a key — drop those
		// names rather than re-key a row onto a coin flip.
		std::erase_if(live, [&](const Live& l) {
			return std::any_of(live.begin(), live.end(), [&](const Live& o) {
				return o.name == l.name && (o.formId != l.formId || o.plugin != l.plugin);
			});
		});

		for (auto& a : cfg.assignments) {
			// FO's LIVE roster wins whenever it knows this name: it is the only
			// authority correct in the CURRENT load order, and preferring it also
			// covers a stored id that resolves — to a stranger.
			const auto want = Lower(a.name);
			const auto hit  = want.empty() ? live.end()
										   : std::find_if(live.begin(), live.end(),
												 [&](const Live& l) { return l.name == want; });
			if (hit != live.end()) {
				if (hit->formId != a.formId || hit->plugin != a.plugin) {
					logger::warn("Wardrobe: re-keyed \"{}\" {}|{} -> {}|{} — the stored FormID was minted in a "
								 "different load order{}",
						a.name, a.formId, a.plugin.empty() ? "(no plugin)" : a.plugin, hit->formId,
						hit->plugin,
						ActorIdentity::ResolvesToStranger(a.formId, a.plugin, a.name)
							? " and was pointing at somebody else"
							: " and no longer addresses anyone");
					a.formId = hit->formId;
					a.plugin = hit->plugin;
					changed  = true;
				}
				continue;
			}
			// Not a follower FO lists. Best effort on what we hold, refusing to
			// canonicalise onto a stranger.
			if (ActorIdentity::CanonicaliseActor(a.formId, a.plugin, a.name))
				changed = true;
			else if (ActorIdentity::ResolvesToStranger(a.formId, a.plugin, a.name))
				logger::warn("Wardrobe: \"{}\" is stored as {}|{}, which resolves to a DIFFERENT actor and "
							 "is not in Follower Organizer's roster — left alone; dressing her would dress him",
					a.name, a.formId, a.plugin.empty() ? "(no plugin)" : a.plugin);
		}

		// A re-key can land two assignments on one person. Fold them: the first
		// wins, but a real mode/outfit beats an "off" placeholder, because the row
		// that still carries her clothes is the one worth keeping.
		std::vector<std::string> keys;
		std::vector<Assignment>  kept;
		for (const auto& a : cfg.assignments) {
			const auto key = ActorKey(a.formId, a.plugin);
			const auto at  = std::find(keys.begin(), keys.end(), key);
			if (at == keys.end()) {
				keys.push_back(key);
				kept.push_back(a);
				continue;
			}
			auto& keep = kept[static_cast<std::size_t>(at - keys.begin())];
			if ((keep.mode.empty() || keep.mode == "off") && !a.mode.empty() && a.mode != "off") {
				const auto id  = keep.formId;
				const auto plg = keep.plugin;
				keep           = a;
				keep.formId    = id;
				keep.plugin    = plg;
			}
			logger::warn("Wardrobe: merged a duplicate assignment for \"{}\" (key {})", keep.name, key);
			changed = true;
		}
		if (changed)
			cfg.assignments = std::move(kept);
		return changed;
	}

	std::string OpenJson(const Config& c, const std::string& foStateJson)
	{
		auto j         = ToJson(c);
		j["soes"]      = SoesJson();
		MergePendingOutfits(j["soes"], c);   // a just-made outfit shows at once
		j["npcs"]      = NpcsJson(c, foStateJson);
		j["inventory"] = InventoryJson();
		j["now"]       = DaysPassed();
		return j.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string StateJson(const Config& c, const std::string& foStateJson)
	{
		nlohmann::json rolls = nlohmann::json::array();
		for (const auto& a : c.assignments)
			if (!a.lastOutfit.empty())
				rolls.push_back(nlohmann::json{ { "formId", a.formId }, { "plugin", a.plugin },
					{ "outfit", a.lastOutfit }, { "day", a.lastRollDay } });
		auto soes = SoesJson();
		MergePendingOutfits(soes, c);        // …on every refresh, not just on open
		return nlohmann::json{ { "soes", soes }, { "npcs", NpcsJson(c, foStateJson) },
			{ "inventory", InventoryJson() }, { "rolls", rolls }, { "now", DaysPassed() } }
			.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	// ---------------------------------------------------------------- actions


	// Dress the PLAYER in a named outfit, right now, with no assignment involved.
	//
	// Dress() above is the auto-switcher's path: it looks up what this actor is
	// ASSIGNED and applies that. Photographing an outfit is the opposite request
	// — "put this specific thing on me so I can look at it" — so it talks to the
	// same SOES mod event directly. Nothing is persisted; the next auto-switch
	// puts the player back into whatever they are actually assigned.
	std::string DressNow(const std::string& reqJson)
	{
		auto j = nlohmann::json::parse(reqJson, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return R"({"ok":false,"msg":"bad request"})";
		const std::string outfit = j.value("outfit", std::string(""));
		if (outfit.empty())
			return nlohmann::json{ { "ok", false }, { "msg", "No outfit named" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		if (!CatalogueHas(outfit))
			return nlohmann::json{ { "ok", false }, { "msg", "SOES has no outfit called \"" + outfit + "\"" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player)
			return nlohmann::json{ { "ok", false }, { "msg", "No player" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

		SendEvent(kEvDress, outfit, 0.0f, player);
		logger::info("Wardrobe: DressNow player -> '{}'", outfit);
		return nlohmann::json{ { "ok", true }, { "msg", "Wearing " + outfit } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string EquipPiece(const std::string& reqJson)
	{
		auto j = nlohmann::json::parse(reqJson, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return R"({"ok":false,"msg":"bad request"})";
		auto* armo   = ResolveArmor(j.value("formId", std::string("")),
			  j.value("plugin", std::string("")));
		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!armo || !player)
			return nlohmann::json{ { "ok", false }, { "msg", "That piece did not resolve" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		// Only things actually in the player's inventory — equipping a bare base
		// form the player does not hold is a silent no-op at best.
		bool have = false;
		for (const auto& [obj, data] : player->GetInventory())
			if (obj == armo && data.first > 0) {
				have = true;
				break;
			}
		if (!have)
			return nlohmann::json{ { "ok", false }, { "msg", "You are not carrying that" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		if (auto* em = RE::ActorEquipManager::GetSingleton())
			em->EquipObject(player, armo);
		const char*       nm  = armo->GetFullName();
		const std::string who = (nm && *nm) ? nm : "it";
		logger::info("Wardrobe: player equips piece '{}'", who);
		return nlohmann::json{ { "ok", true }, { "msg", "Equipped " + who } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	/* "Just put it on her" — no assignment, no tracking, no SOES event.
	 *
	 * Every other way to dress an NPC here enrols her in something: Dress() needs
	 * an Assignment and hands her to SOES, nfCopy pours the pieces into one of
	 * NFF's three sets. Sometimes you are standing in front of someone and want
	 * her wearing a thing, full stop — so this adds the outfit's pieces to her
	 * inventory and force-equips them, and then nothing owns the result.
	 *
	 * Pieces are read through Wardrobe::OutfitPiecesJson, the ONE parser for
	 * SOES's export (nfCopy does the same); a second reader here would be a
	 * second thing to keep in step with SOES's json.
	 *
	 * forceEquip + applyNow, because the point is that it happens NOW and in
	 * front of you: the queued path lands on the actor's next AI update, which
	 * on a follower standing still can be seconds away and reads as "nothing
	 * happened". A piece she already carries is equipped rather than handed to
	 * her twice.
	 */
	std::string GiveAndWear(const std::string& reqJson)
	{
		auto j = nlohmann::json::parse(reqJson, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return R"({"ok":false,"msg":"bad request"})";
		const std::string formId = j.value("formId", std::string(""));
		const std::string plugin = j.value("plugin", std::string(""));
		const std::string outfit = j.value("outfit", std::string(""));
		if (outfit.empty())
			return nlohmann::json{ { "ok", false }, { "msg", "No outfit named" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

		auto* actor = ResolveActor(formId, plugin);
		if (!actor)
			return nlohmann::json{ { "ok", false }, { "msg", "That person isn't loaded" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		const char*       nmc  = actor->GetDisplayFullName();
		const std::string who  = (nmc && *nmc) ? std::string(nmc) : std::string("her");

		auto* eqm = RE::ActorEquipManager::GetSingleton();
		if (!eqm)
			return nlohmann::json{ { "ok", false }, { "msg", "The equip manager isn't available right now" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

		const auto pj = nlohmann::json::parse(
			OutfitPiecesJson(nlohmann::json{ { "name", outfit } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace)), nullptr, false);
		if (pj.is_discarded() || !pj.is_object() || !pj.value("ok", false))
			return nlohmann::json{ { "ok", false },
				{ "msg", (pj.is_object() ? pj.value("msg", std::string("Couldn't read that outfit"))
										 : std::string("Couldn't read that outfit")) } }
				.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

		int worn = 0, missing = 0;
		for (const auto& it : pj["items"]) {
			if (!it.is_object())
				continue;
			auto* armo = ResolveArmor(it.value("formId", std::string("")),
				it.value("plugin", std::string("")));
			if (!armo) {
				++missing;
				continue;
			}
			// Only hand her one if she has none — otherwise a repeated apply
			// quietly fills her pack with duplicates of the same cuirass.
			bool have = false;
			for (const auto& [obj, data] : actor->GetInventory())
				if (obj == armo && data.first > 0) {
					have = true;
					break;
				}
			if (!have)
				actor->AddObjectToContainer(armo, nullptr, 1, nullptr);
			eqm->EquipObject(actor, armo, nullptr, 1, nullptr,
				/*queueEquip*/ true, /*forceEquip*/ true, /*playSounds*/ false, /*applyNow*/ true);
			++worn;
		}

		if (!worn) {
			const std::string why = missing
				? "None of \"" + outfit + "\"'s pieces resolve any more — their plugins may be gone"
				: "\"" + outfit + "\" has no pieces in it";
			logger::warn("wardrobe: give-and-wear \"{}\" on \"{}\" put nothing on ({} unresolved)",
				outfit, who, missing);
			return nlohmann::json{ { "ok", false }, { "msg", why },
				{ "worn", 0 }, { "missing", missing } }
				.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		std::string msg = "Put \"" + outfit + "\" on " + who + " \xE2\x80\x94 " +
			std::to_string(worn) + " piece" + (worn == 1 ? "" : "s");
		if (missing)
			msg += ", " + std::to_string(missing) + " missing";
		logger::info("wardrobe: give-and-wear \"{}\" on \"{}\" ({:08X}) - {} worn, {} unresolved",
			outfit, who, static_cast<std::uint32_t>(actor->GetFormID()), worn, missing);
		Notify(msg);
		return nlohmann::json{ { "ok", true }, { "msg", msg },
			{ "worn", worn }, { "missing", missing } }
			.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string Dress(Config& cfg, const std::string& reqJson)
	{
		auto j = nlohmann::json::parse(reqJson, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return R"({"ok":false,"msg":"bad request"})";
		const std::string formId = j.value("formId", std::string(""));
		const std::string plugin = j.value("plugin", std::string(""));

		Assignment* a = FindAssign(cfg, formId, plugin);
		if (!a || a->mode == "off")
			return nlohmann::json{ { "ok", false }, { "msg", "Nothing assigned" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

		RE::Actor* actor = ResolveActor(formId, plugin);
		if (!actor)
			return nlohmann::json{ { "ok", false },
				{ "msg", a->name.empty() ? "That person isn't loaded" : a->name + " isn't loaded" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

		std::string pick;
		if (a->mode == "outfit") {
			pick = a->outfit;
			if (pick.empty())
				return nlohmann::json{ { "ok", false }, { "msg", "No outfit chosen" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			if (!CatalogueHas(pick))
				return nlohmann::json{ { "ok", false }, { "msg", "SOES has no outfit called \"" + pick + "\"" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		} else {
			Pool* p = FindPool(cfg, a->wardrobeId);
			if (!p)
				return nlohmann::json{ { "ok", false }, { "msg", "That wardrobe is gone" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			pick = RollFrom(*p, a->lastOutfit);
			if (pick.empty())
				return nlohmann::json{ { "ok", false },
					{ "msg", "\"" + p->name + "\" has no outfit SOES still knows" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		ApplyAssignment(cfg, *a, actor, pick);
		const std::string msg = (a->name.empty() ? std::string("Dressed") : a->name) + " \xE2\x86\x92 " + pick;
		if (cfg.notify)
			Notify(msg);
		return nlohmann::json{ { "ok", true }, { "msg", msg }, { "outfit", pick } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string SetTracked(const Config& cfg, const std::string& reqJson)
	{
		auto j = nlohmann::json::parse(reqJson, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return R"({"ok":false,"msg":"bad request"})";
		const std::string formId = j.value("formId", std::string(""));
		const std::string plugin = j.value("plugin", std::string(""));
		const bool        track  = j.value("track", false);

		RE::Actor* actor = ResolveActor(formId, plugin);
		if (!actor)
			return nlohmann::json{ { "ok", false }, { "msg", "That person isn't loaded" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

		if (track) {
			// HARD RULE. A tracked actor with no resolvable outfit gets stripped
			// every 2 s poll — the White Hearth crash-loop. Refuse, don't warn.
			const Assignment* a = nullptr;
			const auto        want = ActorKey(formId, plugin);
			for (const auto& x : cfg.assignments)
				if (ActorKey(x.formId, x.plugin) == want)
					a = &x;
			if (!a || a->mode == "off")
				return nlohmann::json{ { "ok", false },
					{ "msg", "Give them an outfit first \xE2\x80\x94 SOES strips a tracked actor it can't dress" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		SendEvent(kEvTrack, "", track ? 1.0f : 0.0f, actor);
		return nlohmann::json{ { "ok", true },
			{ "msg", track ? "Tracking in SOES" : "No longer tracked" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	namespace
	{
		/* The one place an outfit is actually built. The portal replay and the
		 * deck's own Build button both come through here, so the two paths can
		 * never drift. Returns {built, missing} counts. */
		std::pair<int, int> BuildCore(const std::string& name, const nlohmann::json& items)
		{
			std::vector<RE::TESObjectARMO*> pieces;
			int                             missing = 0;
			for (const auto& it : items) {
				if (!it.is_object())
					continue;
				auto* armo = ResolveArmor(it.value("formId", std::string("")),
					it.value("plugin", std::string("")));
				if (armo)
					pieces.push_back(armo);
				else
					++missing;
			}
			if (pieces.empty())
				return { 0, missing };

			// Empty-then-fill, so re-building the same name REPLACES rather than
			// doubling every piece.
			SendEvent(kEvNewFit, name, 0.0f, nullptr);
			for (auto* armo : pieces)
				SendEvent(kEvAddPc, name, 0.0f, armo);
			RequestCatalogueRefresh();
			return { static_cast<int>(pieces.size()), missing };
		}
	}

	std::string BuildOutfit(Config& cfg, const std::string& reqJson)
	{
		auto j = nlohmann::json::parse(reqJson, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return R"({"ok":false,"msg":"bad request"})";
		const std::string name = j.value("name", std::string(""));
		if (name.empty() || !j.contains("items") || !j["items"].is_array() || j["items"].empty())
			return nlohmann::json{ { "ok", false }, { "msg", "Name it and pick at least one piece" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

		const auto [built, missing] = BuildCore(name, j["items"]);
		if (!built) {
			const std::string msg = "Couldn't build \"" + name + "\" \xE2\x80\x94 no piece resolved";
			Notify(msg);
			return nlohmann::json{ { "ok", false }, { "msg", msg } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
		// Give it a metadata row now, so it can be photographed and pooled
		// before SOES's next export confirms it exists.
		bool have = false;
		for (const auto& m : cfg.outfitMeta)
			if (m.name == name)
				have = true;
		if (!have) {
			OutfitMeta m;
			m.name = name;
			cfg.outfitMeta.push_back(std::move(m));
		}
		const std::string msg = "Made \"" + name + "\" (" + std::to_string(built) + " pieces)" +
			(missing ? " \xE2\x80\x94 " + std::to_string(missing) + " missing" : "");
		Notify(msg);
		logger::info("Wardrobe: {}", msg);
		return nlohmann::json{ { "ok", true }, { "msg", msg }, { "name", name },
			{ "built", built }, { "missing", missing } }
			.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	bool MaybeRoll(Config& cfg)
	{
		if (!cfg.enabled)
			return false;
		const double now = DaysPassed();
		if (now <= 0.0)
			return false;

		bool changed = false;
		for (auto& a : cfg.assignments) {
			if (a.mode != "wardrobe" || a.cadenceHours <= 0)
				continue;

			// First sight: stamp the clock so enabling a cadence never fires a
			// burst of catch-up rolls for time that passed while it was off.
			if (a.lastRollDay <= 0.0) {
				a.lastRollDay = now;
				changed       = true;
				continue;
			}
			const double due = a.lastRollDay + (static_cast<double>(a.cadenceHours) / 24.0);
			if (now < due)
				continue;

			// Not loaded? Slide the clock forward rather than rolling blind, so
			// they change the next time you actually see them instead of
			// "changing" while nobody is looking.
			RE::Actor* actor = ResolveActor(a.formId, a.plugin);
			if (!actor || !actor->Is3DLoaded()) {
				a.lastRollDay = now;
				changed       = true;
				continue;
			}
			Pool* p = FindPool(cfg, a.wardrobeId);
			if (!p)
				continue;
			const std::string pick = RollFrom(*p, a.lastOutfit);
			if (pick.empty())
				continue;

			ApplyAssignment(cfg, a, actor, pick);
			changed = true;
			if (cfg.notify)
				Notify((a.name.empty() ? std::string("Someone") : a.name) + " changed into " + pick);
		}
		return changed;
	}

	// ------------------------------------------------------------ portal replay

	// Portal sidecar shape (written by the Deck Portal, never the live
	// hotkeys.json — we rewrite that file wholesale on every PersistAll, so a
	// portal write would be silently clobbered by the next in-game edit):
	//   { "version":1, "ops":[
	//       {"op":"image","outfit":"<name>","value":"wardrobe/foo.png"},
	//       {"op":"set","target":"outfit","name":"<n>","key":"note"|"fav","value":"..."},
	//       {"op":"set","target":"assign","formId":"..","plugin":"..","key":"cadenceHours"|"mode"|"wardrobeId"|"outfit","value":".."},
	//       {"op":"pool","id":"<wardrobeId>","add":"<outfit>"|"remove":"<outfit>"},
	//       {"op":"pool-new","id":"<id>","name":"<n>","hue"?:38,"mode"?:"bag","outfits"?:["..."]},
	//       {"op":"pool-del","id":"<id>"},
	//       {"op":"pool-set","id":"<id>","key":"name"|"note"|"mode"|"hue","value":".."},
	//       {"op":"pool-order","id":"<id>","outfits":["..."]},
	//       {"op":"pools-order","ids":["..."]},
	//       {"op":"loc-set","formId":"..","plugin":"..","loc":5600,"wardrobeId":""} ] }
	bool ApplyPortalWardrobe(Config& cfg)
	{
		const auto      file = PortalFile();
		std::error_code ec;
		if (!std::filesystem::exists(file, ec))
			return false;

		bool changed = false;
		{
			std::ifstream in(file, std::ios::binary);
			if (in.is_open()) {
				auto j = nlohmann::json::parse(in, nullptr, false);
				if (!j.is_discarded() && j.is_object() && j.contains("ops") && j["ops"].is_array()) {
					for (const auto& op : j["ops"]) {
						if (!op.is_object())
							continue;
						const std::string kind = op.value("op", std::string(""));

						if (kind == "outfit-new") {
							// Build a REAL SOES outfit out of inventory pieces. The
							// executor creates/empties the outfit, then we feed it one
							// armour at a time (a mod event carries ONE form, on sender).
							const std::string nm = op.value("name", std::string(""));
							if (nm.empty() || !op.contains("items") || !op["items"].is_array())
								continue;
							const auto [built, missing] = BuildCore(nm, op["items"]);
							if (!built) {
								logger::warn("Wardrobe: build \"{}\" resolved 0 of {} pieces — skipped",
									nm, op["items"].size());
								Notify("Couldn't build \"" + nm + "\" \xE2\x80\x94 none of its items resolved");
								continue;
							}
							bool have = false;
							for (const auto& m : cfg.outfitMeta)
								if (m.name == nm)
									have = true;
							if (!have) {
								OutfitMeta nm2;
								nm2.name = nm;
								cfg.outfitMeta.push_back(std::move(nm2));
							}
							logger::info("Wardrobe: built \"{}\" from {} pieces ({} unresolved)", nm, built, missing);
							Notify("Made outfit \"" + nm + "\" (" + std::to_string(built) + " pieces)" +
								(missing ? " \xE2\x80\x94 " + std::to_string(missing) + " missing" : ""));
							changed = true;
						} else if (kind == "outfit-del") {
							const std::string nm = op.value("name", std::string(""));
							if (nm.empty())
								continue;
							SendEvent(kEvDelFit, nm, 0.0f, nullptr);
							// drop our metadata + any pool membership so nothing dangles
							std::erase_if(cfg.outfitMeta, [&](const OutfitMeta& m) { return m.name == nm; });
							for (auto& p : cfg.wardrobes)
								std::erase(p.outfits, nm);
							for (auto& a : cfg.assignments) {
								if (a.outfit == nm)
									a.outfit.clear();
								std::erase_if(a.locationOverrides,
									[&](const LocOverride& o) { return o.outfit == nm; });
							}
							Tombstone(nm);
							RequestCatalogueRefresh();
							changed = true;
						} else if (kind == "image") {
							const std::string name = op.value("outfit", std::string(""));
							if (name.empty())
								continue;
							bool found = false;
							for (auto& m : cfg.outfitMeta)
								if (m.name == name) {
									m.image = op.value("value", std::string(""));
									found = changed = true;
								}
							if (!found) {
								OutfitMeta m;
								m.name  = name;
								m.image = op.value("value", std::string(""));
								cfg.outfitMeta.push_back(std::move(m));
								changed = true;
							}
						} else if (kind == "pool") {
							const std::string id = op.value("id", std::string(""));
							for (auto& p : cfg.wardrobes) {
								if (p.id != id)
									continue;
								const std::string add = op.value("add", std::string(""));
								const std::string rem = op.value("remove", std::string(""));
								if (!add.empty() && std::find(p.outfits.begin(), p.outfits.end(), add) == p.outfits.end()) {
									p.outfits.push_back(add);
									changed = true;
								}
								if (!rem.empty() && std::erase(p.outfits, rem) > 0)
									changed = true;
							}
						} else if (kind == "pool-new") {
							// Create a wardrobe from the phone — the same shape the deck's
							// own "＋ Wardrobe" makes. Idempotent by id, so a replayed
							// sidecar can never mint duplicates.
							const std::string id = op.value("id", std::string(""));
							const std::string nm = op.value("name", std::string(""));
							if (id.empty() || nm.empty() || FindPool(cfg, id))
								continue;
							Pool p;
							p.id   = id;
							p.name = nm;
							p.hue  = std::clamp(op.value("hue", 38), 0, 359);
							p.mode = op.value("mode", std::string("bag")) == "random" ? "random" : "bag";
							if (op.contains("outfits") && op["outfits"].is_array())
								for (const auto& o : op["outfits"]) {
									if (!o.is_string())
										continue;
									const auto onm = o.get<std::string>();
									if (!onm.empty() &&
										std::find(p.outfits.begin(), p.outfits.end(), onm) == p.outfits.end())
										p.outfits.push_back(onm);
								}
							logger::info("Wardrobe: portal created wardrobe \"{}\" ({} outfits)", nm, p.outfits.size());
							Notify("Made wardrobe \"" + nm + "\"" +
								(p.outfits.empty() ? "" : " (" + std::to_string(p.outfits.size()) + " outfits)"));
							cfg.wardrobes.push_back(std::move(p));
							changed = true;
						} else if (kind == "pool-del") {
							// Mirror the deck's own deleteWardrobe(): unhook every wearer
							// and location override; the outfits themselves are untouched.
							const std::string id = op.value("id", std::string(""));
							if (id.empty() || !FindPool(cfg, id))
								continue;
							for (auto& a : cfg.assignments) {
								if (a.wardrobeId == id) {
									a.wardrobeId.clear();
									if (a.mode == "wardrobe")
										a.mode = "off";
								}
								std::erase_if(a.locationOverrides,
									[&](const LocOverride& o) { return o.wardrobeId == id; });
							}
							std::erase_if(cfg.wardrobes, [&](const Pool& p) { return p.id == id; });
							logger::info("Wardrobe: portal deleted wardrobe {}", id);
							changed = true;
						} else if (kind == "pool-set") {
							const std::string id  = op.value("id", std::string(""));
							const std::string key = op.value("key", std::string(""));
							const std::string val = op.value("value", std::string(""));
							Pool* p = FindPool(cfg, id);
							if (!p)
								continue;
							if (key == "name" && !val.empty())
								p->name = val;
							else if (key == "note")
								p->note = val;
							else if (key == "mode" && (val == "bag" || val == "random")) {
								p->mode = val;
								p->bag.clear();   // mode change restarts the cycle, as in-game
							} else if (key == "hue")
								p->hue = std::clamp(std::atoi(val.c_str()), 0, 359);
							else
								continue;
							changed = true;
						} else if (kind == "pool-order") {
							// Reorder ONLY — membership stays with pool add/remove. Listed
							// members come first in the given order, unlisted members keep
							// their relative order behind them, unknown names are ignored.
							// The bag survives: it holds names, not positions.
							const std::string id = op.value("id", std::string(""));
							Pool*             p  = FindPool(cfg, id);
							if (!p || !op.contains("outfits") || !op["outfits"].is_array())
								continue;
							std::vector<std::string> next;
							for (const auto& o : op["outfits"]) {
								if (!o.is_string())
									continue;
								const auto nm = o.get<std::string>();
								if (std::find(p->outfits.begin(), p->outfits.end(), nm) != p->outfits.end() &&
									std::find(next.begin(), next.end(), nm) == next.end())
									next.push_back(nm);
							}
							for (const auto& nm : p->outfits)
								if (std::find(next.begin(), next.end(), nm) == next.end())
									next.push_back(nm);
							if (next != p->outfits) {
								p->outfits = std::move(next);
								changed    = true;
							}
						} else if (kind == "pools-order") {
							// Reorder the wardrobes themselves. Listed ids first, everyone
							// else keeps their relative order behind them.
							if (!op.contains("ids") || !op["ids"].is_array())
								continue;
							std::vector<std::string> want;
							for (const auto& o : op["ids"])
								if (o.is_string())
									want.push_back(o.get<std::string>());
							if (want.empty())
								continue;
							const auto rank = [&](const Pool& p) -> std::size_t {
								const auto it = std::find(want.begin(), want.end(), p.id);
								return it == want.end() ? want.size()
								                        : static_cast<std::size_t>(it - want.begin());
							};
							std::stable_sort(cfg.wardrobes.begin(), cfg.wardrobes.end(),
								[&](const Pool& a, const Pool& b) { return rank(a) < rank(b); });
							changed = true;
						} else if (kind == "cat-new") {
							// An outfit CATEGORY from the phone — the same tags the deck's
							// Outfits sub-tab shows as pills. Idempotent by id.
							const std::string id = op.value("id", std::string(""));
							const std::string nm = op.value("name", std::string(""));
							if (id.empty() || nm.empty())
								continue;
							bool have = false;
							for (const auto& c : cfg.categories)
								if (c.id == id)
									have = true;
							if (have)
								continue;
							Category c;
							c.id   = id;
							c.name = nm;
							c.hue  = std::clamp(op.value("hue", 38), 0, 359);
							cfg.categories.push_back(std::move(c));
							logger::info("Wardrobe: portal created category \"{}\"", nm);
							changed = true;
						} else if (kind == "cat-del") {
							const std::string id = op.value("id", std::string(""));
							if (id.empty())
								continue;
							std::erase_if(cfg.categories, [&](const Category& c) { return c.id == id; });
							for (auto& m : cfg.outfitMeta)
								std::erase(m.categoryIds, id);
							changed = true;
						} else if (kind == "cat-set") {
							const std::string id  = op.value("id", std::string(""));
							const std::string key = op.value("key", std::string(""));
							const std::string val = op.value("value", std::string(""));
							for (auto& c : cfg.categories) {
								if (c.id != id)
									continue;
								if (key == "name" && !val.empty())
									c.name = val;
								else if (key == "hue")
									c.hue = std::clamp(std::atoi(val.c_str()), 0, 359);
								else
									continue;
								changed = true;
							}
						} else if (kind == "outfit-cats") {
							// The COMPLETE tag list for one outfit (replace, not merge) —
							// the phone always sends the whole set, so re-sends converge.
							const std::string nm = op.value("name", std::string(""));
							if (nm.empty() || !op.contains("categoryIds") || !op["categoryIds"].is_array())
								continue;
							std::vector<std::string> ids;
							for (const auto& c : op["categoryIds"])
								if (c.is_string() && !c.get<std::string>().empty())
									ids.push_back(c.get<std::string>());
							bool found = false;
							for (auto& m : cfg.outfitMeta)
								if (m.name == nm) {
									m.categoryIds = ids;
									found         = true;
								}
							if (!found) {
								OutfitMeta m;
								m.name        = nm;
								m.categoryIds = std::move(ids);
								cfg.outfitMeta.push_back(std::move(m));
							}
							changed = true;
						} else if (kind == "loc-set") {
							// Per-location wardrobe override from the phone — the same
							// {loc, wardrobeId} rows the deck's assignment sheet edits.
							// One op per location type; empty wardrobeId removes it.
							auto* a = FindAssign(cfg, op.value("formId", std::string("")),
								op.value("plugin", std::string("")));
							if (!a)
								continue;
							const std::int32_t loc = op.value("loc", -1);
							if (loc < 0 || loc > 6400)
								continue;
							const std::string wid = op.value("wardrobeId", std::string(""));
							const std::string oft = op.value("outfit", std::string(""));
							std::erase_if(a->locationOverrides,
								[&](const LocOverride& o) { return o.loc == loc; });
							if (!oft.empty()) {
								// pin ONE outfit there — base-SOES behaviour
								LocOverride ov;
								ov.loc    = loc;
								ov.outfit = oft;
								a->locationOverrides.push_back(ov);
								logger::info("Wardrobe: portal loc-outfit for '{}' loc {} -> '{}'",
									a->name, loc, oft);
							} else if (!wid.empty()) {
								LocOverride ov;
								ov.loc        = loc;
								ov.wardrobeId = wid;
								a->locationOverrides.push_back(ov);
								logger::info("Wardrobe: portal loc-override for '{}' loc {} -> '{}'",
									a->name, loc, wid);
							} else {
								logger::info("Wardrobe: portal loc-override for '{}' loc {} -> (removed)",
									a->name, loc);
							}
							changed = true;
						} else if (kind == "set") {
							const std::string tgt = op.value("target", std::string(""));
							const std::string key = op.value("key", std::string(""));
							const std::string val = op.value("value", std::string(""));
							if (tgt == "outfit") {
								const std::string name = op.value("name", std::string(""));
								for (auto& m : cfg.outfitMeta)
									if (m.name == name) {
										if (key == "note")
											m.note = val;
										else if (key == "fav")
											m.fav = (val == "1" || val == "true");
										changed = true;
									}
							} else if (tgt == "assign") {
								auto* a = FindAssign(cfg, op.value("formId", std::string("")),
									op.value("plugin", std::string("")));
								if (a) {
									if (key == "mode" && (val == "off" || val == "outfit" || val == "wardrobe"))
										a->mode = val;
									else if (key == "wardrobeId")
										a->wardrobeId = val;
									else if (key == "outfit")
										a->outfit = val;
									else if (key == "cadenceHours")
										a->cadenceHours = std::clamp(std::atoi(val.c_str()), 0, 24 * 30);
									changed = true;
								}
							}
						}
					}
				}
			}
		}
		// Consume it either way — a file we could not apply must not retry forever.
		std::filesystem::remove(file, ec);
		return changed;
	}
}
