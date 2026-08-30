#include "quiver.h"

#include "actor_identity.h"
#include "item_icons.h"

#include <algorithm>
#include <atomic>
#include <cstddef>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <string>

// pch (force-included) provides RE::/SKSE:: and nlohmann json.hpp.

namespace Quiver
{
	using json = nlohmann::json;

	namespace
	{
		// ------------------------------------------------------- sidecar --
		// Own module, own sidecar (the item-explorer precedent) — never a
		// hotkeys.json slice, so the OnJsSave wholesale-replace trap cannot
		// eat it. The file IS the prefs blob; unknown keys survive because
		// writes merge into what was read.
		std::mutex        g_mtx;
		bool              g_loaded = false;
		json              g_prefs = json::object();

		std::filesystem::path SidecarPath()
		{
			return std::filesystem::path("Data") / "SKSE" / "Plugins" / "HotkeyDeck" / "quiver.json";
		}

		std::string Dump(const json& j)
		{
			// error_handler replace: a mod name with a broken byte must never
			// make the dump throw (the anim-scan CTD lesson).
			return j.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		void LoadLocked()
		{
			if (g_loaded)
				return;
			g_loaded = true;
			std::ifstream in(SidecarPath(), std::ios::binary);
			if (!in)
				return;
			try {
				json j = json::parse(in, nullptr, true, true);
				if (j.is_object())
					g_prefs = std::move(j);
			} catch (...) {
				logger::warn("quiver: sidecar unreadable - defaults kept");
			}
		}

		void SaveLocked()
		{
			const auto path = SidecarPath();
			std::error_code ec;
			std::filesystem::create_directories(path.parent_path(), ec);
			auto tmp = path;
			tmp += ".tmp";
			{
				std::ofstream out(tmp, std::ios::trunc | std::ios::binary);
				if (!out.is_open()) {
					logger::warn("quiver: could not write {}", PathU8(tmp));
					return;
				}
				out << Dump(g_prefs);
			}
			std::filesystem::rename(tmp, path, ec);
			if (ec)
				logger::warn("quiver: sidecar rename failed: {}", ec.message());
		}

		// ------------------------------------------------------ identity --
		std::uint32_t ParseHexId(const std::string& s)
		{
			try {
				return static_cast<std::uint32_t>(std::stoul(s, nullptr, 16));
			} catch (...) {
				return 0;
			}
		}

		// File-width-masked local id + plugin, or the raw runtime id for a
		// dynamic form — the wheel/potion-browser identity, verbatim.
		void PutIdentity(json& row, RE::TESForm* form)
		{
			auto* file = form ? form->GetFile(0) : nullptr;
			if (file) {
				const std::uint32_t local =
					form->GetFormID() & (file->IsLight() ? 0xFFFu : 0xFFFFFFu);
				char buf[16];
				std::snprintf(buf, sizeof(buf), "0x%06X", local);
				row["plugin"] = std::string(file->GetFilename());
				row["formId"] = std::string(buf);
			} else {
				row["plugin"] = "";
				row["formId"] = "0x0";
			}
			row["rt"] = form ? form->GetFormID() : 0u;
		}

		// -------------------------------------------------------- reads ---
		// Up to two effect names + magnitudes off an AlchemyItem — the poison
		// chip's line. The widgets FxSummary idiom.
		std::string FxOfAlchemy(const RE::AlchemyItem* alch)
		{
			std::string out;
			int         shown = 0;
			if (!alch)
				return out;
			for (auto* effect : alch->effects) {
				auto* base = effect ? effect->baseEffect : nullptr;
				if (!base)
					continue;
				const char* nm = base->GetName();
				if (!nm || !*nm)
					continue;
				if (shown)
					out += " \xC2\xB7 ";  // " · "
				out += nm;
				const int mag = static_cast<int>(effect->effectItem.magnitude);
				if (mag > 0)
					out += " " + std::to_string(mag);
				if (++shown >= 2)
					break;
			}
			return out;
		}

		// The first ExtraPoison found across an inventory entry's extra
		// lists. Vanilla only ever poisons WEAPONS, but ammo-poison mods
		// attach the same extra to the ammo stack — read it honestly either
		// way.
		json PoisonOf(RE::InventoryEntryData* entry)
		{
			if (!entry || !entry->extraLists)
				return nullptr;
			for (auto* xl : *entry->extraLists) {
				if (!xl)
					continue;
				auto* xp = xl->GetByType<RE::ExtraPoison>();
				if (!xp || !xp->poison)
					continue;
				const char* nm = xp->poison->GetName();
				return json{
					{ "name", (nm && *nm) ? nm : "Poison" },
					{ "count", xp->count },
					{ "fx", FxOfAlchemy(xp->poison) },
				};
			}
			return nullptr;
		}

		// The AMMO record's description (DESC) — where enchanted arrows like
		// Sunhallowed say what they do. Whitespace-normalised and capped: the
		// hub shows a line, not a book page.
		std::string DescOf(RE::TESAmmo* ammo)
		{
			auto* descForm = ammo ? ammo->AsDescriptionForm() : nullptr;
			if (!descForm)
				return "";
			RE::BSString out;
			descForm->GetDescription(out, ammo);
			std::string s = out.c_str() ? out.c_str() : "";
			std::string clean;
			clean.reserve(s.size());
			bool space = false;
			for (char c : s) {
				if (c == '\r' || c == '\n' || c == '\t' || c == ' ') {
					space = !clean.empty();
					continue;
				}
				if (space) {
					clean += ' ';
					space = false;
				}
				clean += c;
			}
			if (clean.size() > 180) {
				clean.resize(177);
				// never split a UTF-8 sequence mid-byte
				while (!clean.empty() && (static_cast<unsigned char>(clean.back()) & 0xC0) == 0x80)
					clean.pop_back();
				clean += "...";
			}
			return clean;
		}
	}

	std::string ListJson(std::string* iconItemsOut)
	{
		json        rows = json::array();
		json        iconItems = json::array();
		std::size_t remembered = 0;   // renders already on disk from a past session
		auto*       player = RE::PlayerCharacter::GetSingleton();
		RE::TESAmmo* nocked = player ? player->GetCurrentAmmo() : nullptr;
		if (player) {
			auto inv = player->GetInventory([](RE::TESBoundObject& o) {
				return o.Is(RE::FormType::Ammo);
			});
			for (auto& [obj, data] : inv) {
				if (data.first <= 0)
					continue;
				auto* ammo = obj ? obj->As<RE::TESAmmo>() : nullptr;
				if (!ammo)
					continue;
				auto*       entry = data.second.get();
				const char* nm = nullptr;
				if (entry)
					nm = entry->GetDisplayName();
				if (!nm || !*nm)
					nm = ammo->GetName();
				if (!nm || !*nm)
					continue;  // nameless test rounds have no business on a ring

				const auto& ad = ammo->GetRuntimeData().data;
				json        row;
				PutIdentity(row, ammo);
				row["name"] = nm;
				row["count"] = data.first;
				row["dmg"] = static_cast<int>(ad.damage);
				row["bolt"] = ammo->IsBolt();
				row["value"] = ammo->GetGoldValue();
				row["equipped"] = (ammo == nocked) || (entry && entry->IsWorn());
				row["gameFav"] = entry && entry->IsFavorited();
				const std::string desc = DescOf(ammo);
				if (!desc.empty())
					row["desc"] = desc;
				if (auto* proj = ad.projectile; proj && proj->data.explosionType)
					row["explode"] = true;
				if (json p = PoisonOf(entry); !p.is_null())
					row["poison"] = std::move(p);

				// The render, if we already have it. Render-once-keep-forever
				// means "already" spans every prior session — this is the
				// whole of the persistence the ring can see, and stamping it
				// here is what makes it paint on frame one.
				const std::string pluginName = row.value("plugin", std::string());
				const std::string localHex = row.value("formId", std::string());
				if (!pluginName.empty() && localHex != "0x0") {
					const std::string art = ItemIcons::IconPathIfRendered(localHex, pluginName);
					if (!art.empty())
						++remembered;
					row["icon"] = art;
					iconItems.push_back(json{ { "formId", localHex },
						{ "plugin", pluginName }, { "name", std::string(nm) } });
				} else {
					// A dynamic/plugin-less form can never be looked up for a
					// render, so say so rather than leaving the view guessing.
					row["icon"] = "";
					row["noIcon"] = true;
				}
				rows.push_back(std::move(row));
			}
		}

		// The launcher line: which bow/crossbow is in hand, and its poison —
		// in vanilla, THAT is what poisons the next shots, so a quiver that
		// never mentioned it would be lying about "poisons on arrows".
		json launcher = nullptr;
		if (player) {
			auto* right = player->GetEquippedObject(false);
			auto* weap = right ? right->As<RE::TESObjectWEAP>() : nullptr;
			if (weap) {
				const auto wt = weap->GetWeaponType();
				const char* kind =
					wt == RE::WEAPON_TYPE::kBow      ? "bow" :
					wt == RE::WEAPON_TYPE::kCrossbow ? "crossbow" :
													   nullptr;
				if (kind) {
					const char* wn = weap->GetName();
					launcher = json{
						{ "name", (wn && *wn) ? wn : "Ranged weapon" },
						{ "kind", kind },
					};
					if (json p = PoisonOf(player->GetEquippedEntryData(false)); !p.is_null())
						launcher["poison"] = std::move(p);
				}
			}
		}

		json prefs;
		{
			std::lock_guard l(g_mtx);
			LoadLocked();
			prefs = g_prefs.is_object() ? g_prefs : json::object();
		}
		// read the size BEFORE the move below empties it
		const std::size_t renderable = iconItems.size();
		if (iconItemsOut)
			*iconItemsOut = iconItems.empty() ? std::string()
											  : Dump(json{ { "items", std::move(iconItems) } });

		// Build markers (hd-markers.json: "quiver: list built", "quiver: art remembered").
		logger::info("quiver: list built ({} ammo kind(s) carried)", rows.size());
		logger::info("quiver: art remembered for {}/{} ammo kind(s) - the rest queue now",
			remembered, renderable);
		return Dump(json{ { "rows", std::move(rows) },
			{ "launcher", std::move(launcher) },
			{ "prefs", std::move(prefs) } });
	}

	std::string UseJson(const std::string& payload)
	{
		const auto j = json::parse(payload, nullptr, false);
		const auto refuse = [](const std::string& msg) {
			return Dump(json{ { "ok", false }, { "msg", msg } });
		};
		if (j.is_discarded() || !j.is_object())
			return refuse("Bad request");

		const std::string   plugin = j.value("plugin", std::string());
		const std::string   idHex = j.value("formId", std::string());
		const std::uint32_t rt = j.value("rt", 0u);

		RE::TESForm* form = nullptr;
		if (!plugin.empty()) {
			if (auto* dh = RE::TESDataHandler::GetSingleton())
				form = dh->LookupForm(ParseHexId(idHex), plugin);
		}
		if (!form && rt)
			form = RE::TESForm::LookupByID(rt);
		auto* ammo = form ? form->As<RE::TESAmmo>() : nullptr;
		if (!ammo)
			return refuse("That ammo's mod is off, or the form is gone");

		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player)
			return refuse("No save loaded");

		std::int32_t            have = 0;
		RE::InventoryEntryData* entry = nullptr;
		{
			auto inv = player->GetInventory([ammo](RE::TESBoundObject& o) { return &o == ammo; });
			for (auto& [o, data] : inv) {
				if (o != ammo)
					continue;
				have = data.first;
				entry = data.second.get();
				break;
			}
		}
		std::string nm = "that ammo";
		if (const char* n = ammo->GetName(); n && *n)
			nm = n;
		if (have <= 0)
			return refuse("You aren't carrying " + nm + " any more");
		auto* eqm = RE::ActorEquipManager::GetSingleton();
		if (!eqm)
			return refuse("The equip manager isn't up");

		const bool worn = (ammo == player->GetCurrentAmmo()) || (entry && entry->IsWorn());
		if (worn) {
			eqm->UnequipObject(player, ammo);
			logger::info("quiver: unequip '{}'", nm);
			return Dump(json{ { "ok", true }, { "msg", "Put away " + nm },
				{ "plugin", plugin }, { "formId", idHex }, { "equipped", false } });
		}
		eqm->EquipObject(player, ammo);
		// Build marker (hd-markers.json: "quiver: nock").
		logger::info("quiver: nock '{}' (x{})", nm, have);
		return Dump(json{ { "ok", true }, { "msg", "Nocked " + nm + " (x" + std::to_string(have) + ")" },
			{ "plugin", plugin }, { "formId", idHex }, { "equipped", true } });
	}

	std::string SaveJson(const std::string& payload)
	{
		const auto j = json::parse(payload, nullptr, false);
		if (j.is_object()) {
			std::lock_guard l(g_mtx);
			LoadLocked();
			// The view owns the schema; keep whatever keys it sends (sort,
			// cat, ring, favs today), so a future pref needs no DLL change.
			for (auto it = j.begin(); it != j.end(); ++it)
				g_prefs[it.key()] = it.value();
			SaveLocked();
		}
		return Dump(json{ { "ok", true } });
	}
}
