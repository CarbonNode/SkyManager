#include "wear_effects.h"

#include <algorithm>
#include <vector>

// pch (force-included) provides RE::/SKSE::, logger and nlohmann json (<json.hpp>).

namespace WearEffects
{
	namespace
	{
		using json = nlohmann::json;

		// ------------------------------------------------------- the registry --

		// One cosmetic mod whose effect is WORN. Adding another oil / liquid /
		// skin mod is one row: its pieces are enumerated from the plugin at
		// runtime, so nothing here needs to know what they are.
		struct WearMod
		{
			const char* plugin;   // the file, as the load order names it
			const char* name;     // the category the view groups under
			const char* glyph;    // row glyph (a typographic mark, never emoji)
			const char* detail;   // one-line description shared by its pieces
		};

		constexpr WearMod kMods[] = {
			{ "[Predator] Liquid Pack v2.esp", "Liquid Pack", "~",
			  "Poured-liquid layer — Torso, Bottom and Face sit on their own "
			  "slots, so they stack; Dye variants take a NiOverride tint" },
		};

		// ------------------------------------------------------- house idioms --

		std::string Lower(std::string s)
		{
			for (auto& c : s)
				c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
			return s;
		}

		bool PluginPresent(const char* plugin)
		{
			auto* dh = RE::TESDataHandler::GetSingleton();
			return dh && (dh->LookupLoadedModByName(plugin) != nullptr ||
							 dh->LookupLoadedLightModByName(plugin) != nullptr);
		}

		RE::Actor* ActorFor(std::uint32_t formId)
		{
			return formId ? RE::TESForm::LookupByID<RE::Actor>(formId) : nullptr;
		}

		std::string PluginOf(const RE::TESForm* f)
		{
			if (!f)
				return "";
			if (const auto* file = f->GetFile(0))
				return file->GetFilename().data();
			return "";
		}

		std::string Dump(const json& j)
		{
			return j.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		std::string Reply(bool ok, const std::string& msg, const std::string& id, bool on)
		{
			json j;
			j["ok"] = ok;
			j["msg"] = msg;
			j["id"] = id;
			j["on"] = on;
			return Dump(j);
		}

		std::string HexUpper(std::uint32_t v)
		{
			char buf[16]{};
			std::snprintf(buf, sizeof(buf), "%06X", v & 0x00FFFFFFu);
			return buf;
		}

		// "wear:<plugin>|<localhex>" — plugin first so the id reads as
		// "which mod, then which piece", and durable across sessions because
		// neither half is a runtime FormID.
		std::string IdFor(const RE::TESObjectARMO* a)
		{
			return "wear:" + Lower(PluginOf(a)) + "|" + HexUpper(a->GetLocalFormID());
		}

		// ------------------------------------------------------- enumeration --

		struct Piece
		{
			RE::TESObjectARMO* armo = nullptr;
			const WearMod*     mod = nullptr;
			std::string        id;
			std::string        name;
		};

		// Every ARMO belonging to a registered, PRESENT wear-mod. Rebuilt per
		// call: this runs only when the modal is open (a handful of times a
		// session, over a form array walk that costs microseconds), and a cache
		// would just be one more thing to invalidate when a mod is toggled.
		std::vector<Piece> Enumerate()
		{
			std::vector<Piece> out;
			auto*              dh = RE::TESDataHandler::GetSingleton();
			if (!dh)
				return out;

			for (const auto& m : kMods) {
				if (!PluginPresent(m.plugin))
					continue;
				const auto want = Lower(m.plugin);
				for (auto* armo : dh->GetFormArray<RE::TESObjectARMO>()) {
					if (!armo)
						continue;
					if (Lower(PluginOf(armo)) != want)
						continue;
					const char* nm = armo->GetFullName();
					if (!nm || !*nm)
						continue;  // an unnamed record is a template, not a wearable
					Piece p;
					p.armo = armo;
					p.mod = &m;
					p.id = IdFor(armo);
					p.name = nm;
					out.push_back(std::move(p));
				}
			}
			std::sort(out.begin(), out.end(), [](const Piece& a, const Piece& b) {
				if (a.mod != b.mod)
					return std::string(a.mod->name) < std::string(b.mod->name);
				return a.name < b.name;
			});
			return out;
		}

		// Worn via the biped-slot scan — 32 GetWornArmor calls, which beats an
		// inventory walk and is the zaz_deck idiom.
		bool IsWorn(RE::Actor* a, RE::TESObjectARMO* armo)
		{
			if (!a || !armo)
				return false;
			for (std::uint32_t bit = 0; bit < 32; ++bit) {
				auto* w = a->GetWornArmor(static_cast<RE::BIPED_MODEL::BipedObjectSlot>(1u << bit));
				if (w == armo)
					return true;
			}
			return false;
		}
	}

	// ----------------------------------------------------------------- public --

	bool AnyPresent()
	{
		for (const auto& m : kMods)
			if (PluginPresent(m.plugin))
				return true;
		return false;
	}

	json ModsJson()
	{
		auto       arr = json::array();
		const auto pieces = Enumerate();
		for (const auto& m : kMods) {
			const bool present = PluginPresent(m.plugin);
			int        count = 0;
			for (const auto& p : pieces)
				if (p.mod == &m)
					++count;
			arr.push_back(json{
				{ "mod", m.name },
				{ "plugin", m.plugin },
				{ "present", present },
				{ "count", count },
			});
		}
		return arr;
	}

	json PiecesJson(std::uint32_t formId)
	{
		auto  arr = json::array();
		auto* a = ActorFor(formId);
		for (const auto& p : Enumerate()) {
			arr.push_back(json{
				{ "id", p.id },
				{ "label", p.name },
				{ "glyph", p.mod->glyph },
				{ "detail", p.mod->detail },
				{ "mod", p.mod->name },
				{ "kind", "wear" },
				{ "present", true },  // Enumerate only yields present mods
				{ "active", IsWorn(a, p.armo) },
			});
		}
		return arr;
	}

	std::string Apply(std::uint32_t formId, const std::string& id, bool on)
	{
		auto* a = ActorFor(formId);
		if (!a)
			return Reply(false, "that NPC isn't loaded any more", id, on);

		const auto pieces = Enumerate();
		const auto it = std::find_if(pieces.begin(), pieces.end(),
			[&](const Piece& p) { return p.id == id; });
		if (it == pieces.end())
			return Reply(false, "that piece isn't in the load order any more", id, on);

		auto* eqm = RE::ActorEquipManager::GetSingleton();
		if (!eqm)
			return Reply(false, "equip manager missing", id, on);

		const char*       raw = a->GetDisplayFullName();
		const std::string who = (raw && *raw) ? raw : "them";

		if (on) {
			if (IsWorn(a, it->armo))
				return Reply(true, who + " already wears " + it->name, id, true);
			a->AddObjectToContainer(it->armo, nullptr, 1, nullptr);
			// wardrobe.cpp's proven equip flags — the same ones zaz_deck uses,
			// so a piece whose mod hangs a script on the equip event behaves
			// identically here and there.
			eqm->EquipObject(a, it->armo, nullptr, 1, nullptr,
				/*queueEquip*/ true, /*forceEquip*/ true, /*playSounds*/ false, /*applyNow*/ true);
			logger::info("wear: apply '{}' to {:08X} (marker wear-effects)", it->id, formId);
			return Reply(true, it->name + " on — " + who, id, true);
		}

		if (!IsWorn(a, it->armo))
			return Reply(true, who + " isn't wearing " + it->name, id, false);
		eqm->UnequipObject(a, it->armo);
		// Take it back out too: leaving it in the inventory is how an NPC
		// re-equips it on her own next AI pass.
		a->RemoveItem(it->armo, 1, RE::ITEM_REMOVE_REASON::kRemove, nullptr, nullptr);
		logger::info("wear: remove '{}' from {:08X}", it->id, formId);
		return Reply(true, it->name + " off — " + who, id, false);
	}
}
