#include "wheel.h"

#include "actor_identity.h"

#include <algorithm>
#include <string>

// pch (force-included) provides RE::/SKSE:: and nlohmann json.hpp.

namespace WheelMenu
{
	using json = nlohmann::json;

	namespace
	{
		// One implementation of the durable identity, and it is ActorIdentity's
		// — see the wall of comment at the top of actor_identity.h for why a
		// private copy of GetLocalFormID() here would be a null-deref waiting
		// for the first dynamic form (a player-enchanted sword IS one).
		std::string   HexOf(std::uint32_t v) { return ActorIdentity::HexOf(v); }
		std::uint32_t ParseHex(const std::string& s) { return ActorIdentity::ParseHex(s); }
		std::uint32_t LocalIdOf(const RE::TESForm* f) { return ActorIdentity::BestIdOf(f); }

		std::string PluginOf(const RE::TESForm* form)
		{
			if (!form)
				return "";
			if (auto* file = form->GetFile(0))
				return std::string(file->GetFilename());
			return "";
		}

		// What KIND of thing this is, in the view's vocabulary. The view groups
		// its picker chips off these strings (weapons / armour / usables /
		// misc), so they are a contract, not a label — renaming one silently
		// empties a category.
		const char* KindOf(RE::TESBoundObject* obj)
		{
			if (!obj)
				return "misc";
			switch (obj->GetFormType()) {
			case RE::FormType::Weapon:     return "weapon";
			case RE::FormType::Armor:      return "armor";
			case RE::FormType::Ammo:       return "ammo";
			case RE::FormType::Scroll:     return "scroll";
			case RE::FormType::Ingredient: return "ingredient";
			case RE::FormType::SoulGem:    return "soulgem";
			case RE::FormType::Book:       return "book";
			case RE::FormType::KeyMaster:  return "key";
			case RE::FormType::Light:      return "light";     // torches: equippable
			case RE::FormType::AlchemyItem:
				{
					auto* alch = obj->As<RE::AlchemyItem>();
					if (alch && alch->IsFood())
						return "food";
					if (alch && alch->IsPoison())
						return "poison";
					return "potion";
				}
			default: return "misc";
			}
		}

		// Everything the equip manager will actually accept. A wedge for
		// anything else still exists (you may want a soul gem on the wheel to
		// SEE the count) — it just answers honestly when clicked rather than
		// pretending to do something.
		bool Equippable(const char* kind)
		{
			const std::string k = kind ? kind : "";
			return k == "weapon" || k == "armor" || k == "ammo" || k == "scroll" ||
			       k == "light" || k == "potion" || k == "food" || k == "poison";
		}

		// Equipping a POTION drinks it and equipping a SCROLL readies it; both
		// are one-shot, so neither is ever a toggle. Only the wearables are.
		bool Toggleable(const char* kind)
		{
			const std::string k = kind ? kind : "";
			return k == "weapon" || k == "armor" || k == "ammo" || k == "light";
		}

		std::string NameOf(RE::TESBoundObject* obj, RE::InventoryEntryData* entry)
		{
			// The ENTRY's display name first: it carries temper and enchantment
			// naming ("Fine Steel Sword of Sparks"), which is exactly what
			// distinguishes the two swords you are carrying from each other.
			if (entry) {
				if (const char* dn = entry->GetDisplayName(); dn && *dn)
					return dn;
			}
			if (obj) {
				if (const char* fn = obj->GetName(); fn && *fn)
					return fn;
			}
			return "";
		}

		// Resolve the durable (local id + plugin) pair back to a live form.
		// Masking and the LookupForm trap are ActorIdentity's problem, not
		// ours — but a bound object is what the equip manager wants, so the
		// cast is checked here.
		RE::TESBoundObject* Resolve(const std::string& formId, const std::string& plugin)
		{
			const std::uint32_t local = ParseHex(formId);
			if (!local)
				return nullptr;
			if (!plugin.empty()) {
				if (auto* dh = RE::TESDataHandler::GetSingleton()) {
					if (auto* f = dh->LookupForm(local, plugin))
						return f->As<RE::TESBoundObject>();
				}
			}
			// Dynamic forms (0xFF……, a player-enchanted piece) have no source
			// file, so BestIdOf stored the full runtime id — which is exactly
			// what LookupByID takes. Correct for this session only, which is
			// all a dynamic form ever is.
			if (auto* f = RE::TESForm::LookupByID(local))
				return f->As<RE::TESBoundObject>();
			return nullptr;
		}
	}

	std::string InventoryJson()
	{
		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player)
			return R"({"ok":false,"msg":"No player","items":[]})";

		json        items = json::array();
		std::size_t skippedUnnamed = 0;
		auto        inv = player->GetInventory();
		for (auto& [obj, data] : inv) {
			if (!obj || data.first <= 0)
				continue;
			auto*             entry = data.second.get();
			const std::string nm    = NameOf(obj, entry);
			if (nm.empty()) {
				++skippedUnnamed;
				continue;
			}
			const char*         kind  = KindOf(obj);
			const std::uint32_t local = LocalIdOf(obj);
			if (!local)
				continue;   // no identity to store; a wedge for it could not survive a reload

			json row{
				{ "formId", HexOf(local) },
				{ "plugin", PluginOf(obj) },
				{ "name", nm },
				{ "kind", kind },
				{ "count", data.first },
				{ "value", obj->GetGoldValue() },
				{ "weight", static_cast<int>(obj->GetWeight() * 10.0f) / 10.0f },
				{ "equipped", entry && entry->IsWorn() },
				{ "favorite", entry && entry->IsFavorited() },
			};
			// The numbers that make one sword tell itself from another on a
			// 96-pixel tile. Read off the ENTRY where the entry knows better
			// (a tempered blade's damage is not the base record's).
			if (auto* wp = obj->As<RE::TESObjectWEAP>())
				row["dmg"] = static_cast<int>(wp->GetAttackDamage());
			if (auto* ar = obj->As<RE::TESObjectARMO>())
				row["armor"] = static_cast<int>(ar->GetArmorRating());
			items.push_back(std::move(row));
		}

		// Never a silent cap: the wheel's picker searches this list, and a
		// truncated one would quietly answer "you are not carrying that".
		if (items.size() > 4000) {
			logger::warn("wheel: inventory has {} named entries - sending all of them anyway "
						 "(a cap here would silently hide items from the picker)",
				items.size());
		}
		logger::info("wheel: inventory read - {} items ({} unnamed rows skipped)",
			items.size(), skippedUnnamed);
		return json{ { "ok", true }, { "items", std::move(items) } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string Use(const std::string& reqJson)
	{
		auto j = json::parse(reqJson, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return R"({"ok":false,"msg":"bad request"})";

		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player)
			return json{ { "ok", false }, { "msg", "No player" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

		const std::string formId = j.value("formId", std::string(""));
		const std::string plugin = j.value("plugin", std::string(""));
		auto*             obj    = Resolve(formId, plugin);
		if (!obj)
			return json{ { "ok", false }, { "msg", "That item didn't resolve - its mod may be off" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

		// Hold it, or the verb is a lie. Walking the inventory also gets us the
		// entry, which is the only thing that knows whether it is WORN.
		RE::InventoryEntryData* entry = nullptr;
		std::int32_t            count = 0;
		{
			auto inv = player->GetInventory([obj](RE::TESBoundObject& o) { return &o == obj; });
			for (auto& [o, data] : inv) {
				if (o != obj)
					continue;
				count = data.first;
				entry = data.second.get();
				break;
			}
		}
		const std::string nm = NameOf(obj, entry);
		const std::string who = nm.empty() ? std::string("that") : nm;
		if (count <= 0)
			return json{ { "ok", false }, { "msg", "You aren't carrying " + who + " any more" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

		const char* kind = KindOf(obj);
		if (!Equippable(kind)) {
			// An honest refusal beats a button that appears to work. Named in
			// full so the message says WHY rather than just "no".
			return json{ { "ok", false },
				{ "msg", who + " isn't something you can use from here" } }
				.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		auto* eqm = RE::ActorEquipManager::GetSingleton();
		if (!eqm)
			return json{ { "ok", false }, { "msg", "The equip manager isn't up" } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

		const bool worn = entry && entry->IsWorn();
		if (worn && Toggleable(kind)) {
			eqm->UnequipObject(player, obj);
			logger::info("wheel: player unequips '{}'", who);
			return json{ { "ok", true }, { "msg", "Put away " + who }, { "equipped", false } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		eqm->EquipObject(player, obj);
		const std::string k = kind;
		const std::string verb = (k == "potion" || k == "food") ? "Drank " :
			(k == "poison")                                     ? "Applied " :
			(k == "scroll")                                     ? "Readied " :
																  "Equipped ";
		logger::info("wheel: player equips '{}' ({})", who, kind);
		return json{ { "ok", true }, { "msg", verb + who }, { "equipped", true } }.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}
}
