#include "survival.h"

#include "pch.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#include "hotbar.h"       // ClassifyConsumable / WaterDrinks / WaterModPresent
#include "settlement.h"   // ExecuteAct("campplace") — Campfire's own equip flow

namespace Survival
{
	using json = nlohmann::json;

	namespace
	{
		std::string Dump(const json& j)
		{
			return j.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		std::string Lower(std::string_view s)
		{
			std::string out(s);
			std::transform(out.begin(), out.end(), out.begin(),
				[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			return out;
		}

		bool ModPresent(const char* name)
		{
			auto* dh = RE::TESDataHandler::GetSingleton();
			return dh && dh->LookupModByName(name) != nullptr;
		}

		// The Campfire FAMILY — the same explicit list the Settlement tab's camp
		// tree uses, and for the same reason: "any plugin with campfire in the
		// name" would sweep in visual patches (EmbersXD-Campfire Patch, SDA
		// Campfire Patch) that ship no gear at all.
		bool IsCampPlugin(const std::string& lowerName)
		{
			static const char* const kCamp[] = {
				"campfire.esm",
				"tentapalooza.esp",
				"campfire unleashed.esp",
				"campfire unleashed.esm",
				"hunterborn - campfire patch.esp",
			};
			for (const char* c : kCamp)
				if (lowerName == c)
					return true;
			return false;
		}

		// SunHelm's OWN gear. Dumped from SunHelmSurvival.esp rather than guessed:
		// the full skins and bottles are ALCH (_SHWaterskin_1/2/3, _SHWaterBottle*,
		// and their Salt twins), but the EMPTIES are MISC (_SHWaterskin_Empty,
		// _SHEmptyMeadMisc…). The empties are exactly what you look for when you
		// are standing at a stream, so a water list without them is missing half
		// the point. Patches count too — anything the mod family ships.
		bool IsSurvivalPlugin(const std::string& lowerName)
		{
			return lowerName.rfind("sunhelm", 0) == 0;
		}

		bool LooksEmpty(const std::string& lowerName, const std::string& lowerEdid)
		{
			return lowerName.find("empty") != std::string::npos ||
				   lowerEdid.find("empty") != std::string::npos;
		}

		// Salt water is drinkable and harmful — SunHelm ships it as an ordinary
		// water form, so it classifies as water and would sit in the list looking
		// like a drink. Say what it is, on the row.
		bool LooksSalt(const std::string& lowerName, const std::string& lowerEdid)
		{
			return lowerName.find("salt") != std::string::npos ||
				   lowerEdid.find("salt") != std::string::npos;
		}

		std::string EdidLower(const RE::TESForm* form)
		{
			const char* e = form ? form->GetFormEditorID() : nullptr;
			return (e && *e) ? Lower(e) : std::string();
		}

		// Which drawer a piece of camp gear belongs in. Keyword buckets rather
		// than a hand-maintained FormID table, so a camp mod added to the list
		// above sorts itself the day it lands. Order matters: the first match
		// wins, so the specific words come before the general ones.
		const char* CampSub(const std::string& lower)
		{
			const auto has = [&](const char* w) { return lower.find(w) != std::string::npos; };
			if (has("tent") || has("pavilion") || has("yurt") || has("lean-to") || has("leanto"))
				return "tent";
			if (has("bedroll") || has("bed roll") || has("hammock") || has("sleep"))
				return "bed";
			if (has("fire") || has("flame") || has("ember") || has("brazier") || has("torch") ||
				has("lantern") || has("candle") || has("light"))
				return "fire";
			if (has("pot") || has("cook") || has("spit") || has("grill") || has("kettle") ||
				has("cauldron") || has("stew"))
				return "cook";
			if (has("tan") || has("rack") || has("dry") || has("smok") || has("workbench") ||
				has("anvil") || has("grind") || has("alchemy") || has("enchant"))
				return "craft";
			return "gear";
		}

		const char* SubLabel(const std::string& sub)
		{
			if (sub == "tent")  return "Tents & shelter";
			if (sub == "bed")   return "Bedrolls";
			if (sub == "fire")  return "Fire & light";
			if (sub == "cook")  return "Cooking";
			if (sub == "craft") return "Camp crafting";
			return "Other camp gear";
		}

		std::string HexOf(std::uint32_t local)
		{
			char buf[16];
			std::snprintf(buf, sizeof(buf), "0x%06X", local);
			return buf;
		}

		// The durable id the whole deck speaks: "Plugin.esp|0AB12C". Computed
		// with the file-width mask rather than GetLocalFormID(), which
		// null-derefs on a dynamic form (the actor_identity lesson).
		bool IdOf(const RE::TESForm* form, std::string& outPlugin, std::string& outHex)
		{
			if (!form)
				return false;
			auto* file = form->GetFile(0);
			if (!file)
				return false;   // dynamic — no durable identity, so not listable
			outPlugin = file->GetFilename();
			outHex = HexOf(form->GetFormID() & (file->IsLight() ? 0xFFFu : 0xFFFFFFu));
			return true;
		}

		std::int32_t CarriedCount(RE::TESBoundObject* obj)
		{
			auto* player = RE::PlayerCharacter::GetSingleton();
			if (!player || !obj)
				return 0;
			auto inv = player->GetInventory([obj](RE::TESBoundObject& o) { return &o == obj; });
			const auto it = inv.find(obj);
			return (it != inv.end()) ? it->second.first : 0;
		}

		// ---- SunHelm needs -------------------------------------------------
		//
		// SunHelm Survival keeps every need in a GLOBAL, which is the friendliest
		// possible integration surface: no script call, no menu, no version
		// coupling — look the global up by editor id and read it. Confirmed by
		// dumping SunHelmSurvival.esp's GLOB records (116 of them) rather than
		// guessing at names.
		//
		// A missing global simply means that part of the mod is not installed or
		// not that version, and the view omits the meter rather than inventing a
		// zero — an invented number is worse than no number when you are deciding
		// whether to eat.
		const RE::TESGlobal* GlobalByEdid(const char* edid)
		{
			return RE::TESForm::LookupByEditorID<RE::TESGlobal>(edid);
		}

		bool GlobalValue(const char* edid, float& out)
		{
			if (const auto* g = GlobalByEdid(edid)) {
				out = g->value;
				return true;
			}
			return false;
		}

		// One meter: {id, label, value, max?, note?}. `max` is omitted when the
		// mod does not publish one, and the view then shows the number without a
		// bar rather than drawing a bar against a scale nobody verified.
		void PushNeed(json& arr, const char* id, const char* label, const char* valueEdid,
			const char* capEdid, const char* disabledEdid)
		{
			float v = 0.0f;
			if (!GlobalValue(valueEdid, v))
				return;   // that need is not in this build of the mod
			json n{ { "id", id }, { "label", label }, { "value", v } };
			float cap = 0.0f;
			if (capEdid && GlobalValue(capEdid, cap) && cap > 0.0f)
				n["max"] = cap;
			float off = 0.0f;
			if (disabledEdid && GlobalValue(disabledEdid, off) && off != 0.0f)
				n["off"] = true;   // the player turned this need off in the MCM
			arr.push_back(std::move(n));
		}

		// ---- the mods' OWN actions ----------------------------------------
		//
		// Rober, 2026-08-15: "more for doing things from campfire, tentapalooza,
		// drinking water, filling waterskins, hunterborn actions, etc - but make
		// sure its unique and hooks and only shows in the case of if they are
		// installed."
		//
		// Every action here is one of the mod's OWN lesser powers, self-cast the
		// way the AddItemMenu action already does in this deck: the mod's magic
		// effect runs its own Papyrus from there, so its menus, perks and rules
		// are the mod's, not a reimplementation. The catalogue below was read out
		// of the plugins (SPEL records dumped from Campfire.esm / Hunterborn.esp),
		// not guessed.
		//
		// GATING IS BY RESOLUTION, not by a mod list: a row appears only when its
		// spell actually resolves by EDITOR ID in the live load order. Uninstall
		// the mod and the row is simply not there — never a button that fails.
		struct ActionDef
		{
			const char* id;
			const char* edid;    // editor id of the mod's own power
			const char* label;
			const char* hint;
			const char* group;   // which mod's block it belongs to
		};

		const ActionDef kActions[] = {
			// Campfire — its own powers, exactly as the mod names them.
			{ "camp-build", "_Camp_CampfireSpell", "Build a campfire",
			  "Campfire's own build flow - placement, perks and fuel all its rules", "Campfire" },
			{ "camp-craft", "_Camp_CreateItemSpell", "Craft camp gear",
			  "Campfire's Create Item menu - tents, bedrolls, cookware from what you carry", "Campfire" },
			{ "camp-wood", "_Camp_HarvestWoodSpell", "Harvest firewood",
			  "Take wood from a dead tree or a woodpile nearby", "Campfire" },
			{ "camp-instincts", "_Camp_SurvivalVisionPower", "Instincts",
			  "Campfire's survival vision", "Campfire" },
			{ "camp-options", "_Camp_LegacyConfig_Spell", "Campfire options",
			  "The mod's own settings menu", "Campfire" },
			// Wintersun — praying is the mod's whole loop, and it is a lesser
			// power (WSN_Prayer_Spell, "Pray"); at a shrine it has its own
			// Worship spell. Both resolve only when the mod is installed.
			{ "wsn-pray", "WSN_Prayer_Spell", "Pray",
			  "Wintersun's prayer to your deity - favor, tenets, the lot", "Wintersun" },
			{ "wsn-worship", "WSN_Prayer_Spell_AtShrine", "Worship at a shrine",
			  "The shrine version - stand at one first", "Wintersun" },
			// Hunterborn — the doing-things powers only; its perks, curses and
			// summons are not menu actions and would only pad the list.
			{ "hb-forage", "_DS_SPEL_Forage", "Forage",
			  "Hunterborn's foraging - what grows here, gathered properly", "Hunterborn" },
			{ "hb-taxonomy", "_DS_SPEL_Taxonomy", "Taxonomy",
			  "Study a carcass or creature for what Hunterborn knows about it", "Hunterborn" },
			{ "hb-scrimshaw", "_DS_SPEL_Scrimshaw", "Scrimshaw",
			  "Carve bone and antler into something worth carrying", "Hunterborn" },
			{ "hb-scavenge", "_DS_SPEL_Scavenging", "Scavenging",
			  "Hunterborn's scavenging pass over what is around you", "Hunterborn" },
		};

		RE::SpellItem* SpellByEdid(const char* edid)
		{
			return RE::TESForm::LookupByEditorID<RE::SpellItem>(edid);
		}

		// ---- the hero: what your survival career actually looks like -------
		//
		// Rober: "maybe a top hero area where you can put in like analytics for
		// your supported mods? How many days survived? … tents pitched, skinned,
		// things crafted."
		//
		// Every number here is one the MODS THEMSELVES keep — dumped from their
		// globals, not invented and not tallied by us behind their back:
		//   Hunterborn  _DS_Hunterborn_SkinningDone / _HarvestingDone /
		//               _TotalCleans, and the Skin/Harvest/Forage levels + exp
		//   Campfire    CampingPerkPoints / …Earned / …Total, and each perk's
		//               rank against its own _Max
		//   vanilla     GameDaysPassed — days survived, the honest way
		//
		// The same bar rule as the needs strip: a BAR only where the mod
		// publishes the maximum (perk ranks do), otherwise the number alone. An
		// exp value with no published curve gets no bar, because a bar would be
		// claiming to know how close you are when we do not.
		void PushStatBar(json& arr, const char* label, const char* rankEdid, const char* maxEdid)
		{
			float rank = 0.0f, max = 0.0f;
			if (!GlobalValue(rankEdid, rank))
				return;
			json b{ { "label", label }, { "value", rank } };
			if (maxEdid && GlobalValue(maxEdid, max) && max > 0.0f)
				b["max"] = max;
			arr.push_back(std::move(b));
		}

		void PushStatNum(json& arr, const char* label, const char* edid, const char* suffix = nullptr)
		{
			float v = 0.0f;
			if (!GlobalValue(edid, v))
				return;
			json n{ { "label", label }, { "value", v } };
			if (suffix)
				n["suffix"] = suffix;
			arr.push_back(std::move(n));
		}

		// ---- the deep read: what the mods track and never show you ---------
		//
		// Rober: "im talking more stats or stuff we dont show in UI". These mods
		// keep a whole model in globals and surface almost none of it — SunHelm
		// shows four needs on a widget while holding the entire temperature
		// calculation, your burn rates and nine perk ranks; Hunterborn keeps four
		// skills with exp; Campfire tracks your progress toward the next perk
		// point. All of it is readable, none of it is visible anywhere in game.
		//
		// One row per global that EXISTS. A missing one is skipped, never shown
		// as zero, so this panel is always a true statement about your load order.
		void StatRow(json& arr, const char* label, const char* edid,
			const char* note = nullptr, bool asInt = true)
		{
			float v = 0.0f;
			if (!GlobalValue(edid, v))
				return;
			json r{ { "label", label },
					{ "value", asInt ? std::floor(v + 0.5f) : v },
					{ "int", asInt } };
			if (note)
				r["note"] = note;
			arr.push_back(std::move(r));
		}

		void StatGroup(json& groups, const char* label, json rows, const char* hint = nullptr)
		{
			if (rows.empty())
				return;
			json g{ { "label", label }, { "rows", std::move(rows) } };
			if (hint)
				g["hint"] = hint;
			groups.push_back(std::move(g));
		}

		struct Row
		{
			std::string plugin, hex, name, sub, detail;
			std::int32_t count = 0;
			// "" = the section's default verb. An empty waterskin sets "none":
			// filling is contextual (SunHelm's own key at fresh water), so a
			// button here would promise something it cannot do.
			std::string verb;
		};

		void PushRow(json& arr, const Row& r, const char* sectionVerb)
		{
			const char* verb = r.verb.empty() ? sectionVerb : r.verb.c_str();
			arr.push_back(json{
				{ "id", r.plugin + "|" + r.hex },
				{ "plugin", r.plugin },
				{ "formId", r.hex },
				{ "name", r.name },
				{ "count", r.count },
				{ "sub", r.sub },
				{ "detail", r.detail },
				{ "verb", verb } });
		}

		bool ByName(const Row& a, const Row& b)
		{
			return Lower(a.name) < Lower(b.name);
		}
	}

	// ---- the tab's card layout (opaque to us on purpose) -------------------
	namespace
	{
		std::filesystem::path LayoutPath()
		{
			return std::filesystem::path("Data") / "SKSE" / "Plugins" / "HotkeyDeck" / "survival.json";
		}
	}

	std::string LayoutJson()
	{
		std::ifstream in(LayoutPath(), std::ios::binary);
		if (in) {
			auto j = json::parse(in, nullptr, false);
			if (!j.is_discarded() && j.is_object())
				return Dump(j);
		}
		return Dump(json{ { "cards", json::array() } });
	}

	std::string SaveLayout(const std::string& req)
	{
		auto j = json::parse(req, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return Dump(json{ { "ok", false } });
		std::error_code ec;
		std::filesystem::create_directories(LayoutPath().parent_path(), ec);
		std::ofstream out(LayoutPath(), std::ios::binary | std::ios::trunc);
		if (!out)
			return Dump(json{ { "ok", false } });
		out << Dump(j);
		return Dump(json{ { "ok", true } });
	}

	std::string StateJson()
	{
		const bool campfire = ModPresent("Campfire.esm");
		const bool tenta = ModPresent("Tentapalooza.esp");
		const bool unleashed = ModPresent("Campfire Unleashed.esp") || ModPresent("Campfire Unleashed.esm");
		const bool hunterborn = ModPresent("Hunterborn.esp");
		const bool waterMod = Hotbar::WaterModPresent();

		std::vector<Row> camp, water, food, drink;

		auto* player = RE::PlayerCharacter::GetSingleton();
		if (player) {
			// ONE inventory walk for everything: alchemy is classified by the
			// shared classifier (which already knows SunHelm's water forms), and
			// anything else is camp gear only when its own plugin says so.
			auto inv = player->GetInventory([](RE::TESBoundObject& o) {
				return o.Is(RE::FormType::AlchemyItem) || o.Is(RE::FormType::Misc) ||
					   o.Is(RE::FormType::Light) || o.Is(RE::FormType::Book);
			});
			for (auto& [obj, data] : inv) {
				if (!obj || data.first <= 0)
					continue;
				const char* nm = obj->GetName();
				if (!nm || !*nm)
					continue;   // nameless plumbing is never survival gear

				Row r;
				if (!IdOf(obj, r.plugin, r.hex))
					continue;
				r.name = nm;
				r.count = data.first;

				const std::string lowerName = Lower(r.name);
				const std::string lowerEdid = EdidLower(obj);

				if (auto* alch = obj->As<RE::AlchemyItem>()) {
					// Potions and poisons belong to the Potion Browser; this
					// menu is food, drink and water — what keeps you alive
					// outdoors rather than what heals you in a fight.
					switch (Hotbar::ClassifyConsumable(alch)) {
					case Hotbar::ConsumableKind::kWater:
						{
							const int drinks = Hotbar::WaterDrinks(alch);
							if (drinks > 1)
								r.detail = std::to_string(drinks) + " drinks each";
							if (LooksSalt(lowerName, lowerEdid))
								r.detail = r.detail.empty()
									? std::string("salt water - drinking it makes you thirstier")
									: r.detail + " - SALT water";
							water.push_back(std::move(r));
						}
						break;
					case Hotbar::ConsumableKind::kDrink:
						drink.push_back(std::move(r));
						break;
					case Hotbar::ConsumableKind::kFood:
						food.push_back(std::move(r));
						break;
					default:
						break;   // potion / poison — not ours
					}
					continue;
				}

				// Camp gear: membership is the plugin, the drawer is the name.
				if (IsCampPlugin(Lower(r.plugin))) {
					r.sub = CampSub(lowerName);
					camp.push_back(std::move(r));
					continue;
				}

				// The survival mod's own non-consumable gear — its empties above
				// all. They ride the Water section with no verb of their own:
				// filling is contextual (SunHelm's own fill key at fresh water),
				// and a button here that pretended otherwise would be a lie.
				if (IsSurvivalPlugin(Lower(r.plugin))) {
					if (LooksEmpty(lowerName, lowerEdid)) {
						r.detail = "empty - refill at fresh water";
						r.sub = "empty";
						r.verb = "none";
						water.push_back(std::move(r));
					}
				}
			}
		}

		std::sort(camp.begin(), camp.end(), [](const Row& a, const Row& b) {
			if (a.sub != b.sub)
				return a.sub < b.sub;
			return ByName(a, b);
		});
		std::sort(water.begin(), water.end(), ByName);
		std::sort(food.begin(), food.end(), ByName);
		std::sort(drink.begin(), drink.end(), ByName);

		json sections = json::array();

		// ---- Actions: what the installed mods can DO, first because that is
		// what you opened this for. A row exists only if its power resolves.
		{
			json rows = json::array();
			json subs = json::array();
			std::vector<std::string> groupsSeen;
			for (const auto& a : kActions) {
				auto* spell = SpellByEdid(a.edid);
				if (!spell)
					continue;   // that mod (or that version of it) is not here
				std::string plugin, hex;
				if (!IdOf(spell, plugin, hex))
					continue;
				/* "act" is the STABLE identity of the verb (never the form id, which
				 * differs per load order): the view maps it to one of the deck's own
				 * gold-glyph icons. An action is a lesser power — it ships no world
				 * model, so the item-render route can never draw it and used to leave
				 * the row on a skeleton for ever (Rober, 2026-08-16). marker: survival-act-id */
				rows.push_back(json{
					{ "id", plugin + "|" + hex },
					{ "act", a.id },
					{ "plugin", plugin },
					{ "formId", hex },
					{ "name", a.label },
					{ "detail", a.hint },
					{ "sub", a.group },
					{ "count", 1 },
					{ "verb", "cast" } });
				if (std::find(groupsSeen.begin(), groupsSeen.end(), a.group) == groupsSeen.end()) {
					groupsSeen.push_back(a.group);
					subs.push_back(json{ { "id", a.group }, { "label", a.group } });
				}
			}
			// The two verbs you actually want in a hurry, computed at PRESS time
			// rather than pinned to a form: "the best" changes as you drink it.
			// They ride the same use verb, so nothing new is implemented.
			for (const auto& smart : { std::pair<const char*, const char*>{ "water", "Drink the best water" },
									   std::pair<const char*, const char*>{ "food", "Eat the best food" } }) {
				const bool haveWater = !water.empty(), haveFood = !food.empty();
				if ((std::string(smart.first) == "water" && !haveWater) ||
					(std::string(smart.first) == "food" && !haveFood))
					continue;
				rows.push_back(json{
					{ "id", std::string("smart|") + smart.first },
					{ "act", std::string("smart-") + smart.first },
					{ "plugin", "" }, { "formId", "" },
					{ "name", smart.second },
					{ "detail", std::string(smart.first) == "water"
						? "Picks the fullest waterskin or bottle you carry, right now"
						: "Picks the most nourishing meal you carry, right now" },
					{ "sub", "Quick" },
					{ "count", 1 },
					{ "verb", "smart" } });
			}
			if (!water.empty() || !food.empty())
				subs.insert(subs.begin(), json{ { "id", "Quick" }, { "label", "Quick" } });

			// SunHelm's fill is not a power — it is a HOTKEY its own script
			// listens for, and the mod publishes that key as a global. So the row
			// asks the deck to press the mod's own key (OS-level SendInput is
			// this deck's oldest trick), which is as close to "the mod's own
			// mechanism" as a key-driven feature gets. No key set in the MCM =
			// no row, rather than a button that does nothing.
			{
				float fill = 0.0f;
				if (GlobalValue("_SHFillHotKey", fill) && fill >= 1.0f && fill <= 255.0f) {
					rows.push_back(json{
						{ "id", "sunhelm|fill" },
						{ "act", "sunhelm-fill" },
						{ "plugin", "" }, { "formId", "" },
						{ "name", "Fill waterskin" },
						{ "detail", "Presses SunHelm's own fill key - stand at fresh water first" },
						{ "sub", "SunHelm" },
						{ "count", 1 },
						{ "key", static_cast<int>(fill) },
						{ "verb", "key" } });
					subs.push_back(json{ { "id", "SunHelm" }, { "label", "SunHelm" } });
				}
			}
			sections.push_back(json{
				{ "id", "do" },
				{ "label", "Actions" },
				{ "hint", "Nothing to do here yet — Campfire and Hunterborn are what fill this list." },
				{ "subs", std::move(subs) },
				{ "rows", std::move(rows) } });
		}

		{
			json rows = json::array();
			for (const auto& r : camp)
				PushRow(rows, r, "camp");
			// Every drawer that has anything is named, so the view can group
			// without knowing the keyword rules.
			json subs = json::array();
			for (const char* s : { "tent", "bed", "fire", "cook", "craft", "gear" }) {
				const bool any = std::any_of(camp.begin(), camp.end(),
					[&](const Row& r) { return r.sub == s; });
				if (any)
					subs.push_back(json{ { "id", s }, { "label", SubLabel(s) } });
			}
			sections.push_back(json{
				{ "id", "camp" },
				{ "label", "Camp" },
				{ "hint", campfire
						? "Placing hands over to Campfire's own controls, so its rules and perks apply."
						: "Campfire isn't in your load order, so there is no camp gear to carry." },
				{ "subs", std::move(subs) },
				{ "rows", std::move(rows) } });
		}

		const auto simpleSection = [&](const char* id, const char* label, const char* hint,
									   const std::vector<Row>& src) {
			json rows = json::array();
			for (const auto& r : src)
				PushRow(rows, r, "use");
			sections.push_back(json{ { "id", id }, { "label", label }, { "hint", hint },
				{ "subs", json::array() }, { "rows", std::move(rows) } });
		};
		simpleSection("water", "Water",
			waterMod ? "Drinking runs the water mod's own script, so your thirst updates properly."
					 : "No water mod detected — anything drinkable still shows under Drink.",
			water);
		simpleSection("food", "Food", "Solid meals. Eating is the same verb the wheel uses.", food);
		simpleSection("drink", "Drink", "Ale, mead, wine, tea, milk — anything you drink that isn't plain water.", drink);

		logger::info("survival: state built - {} camp, {} water, {} food, {} drink",
			camp.size(), water.size(), food.size(), drink.size());

		// The needs strip. SunHelm is the hunger/thirst/fatigue/cold mod on this
		// setup; its own MCM switch (_SHEnabled) decides whether any of it is
		// live, and each need has a "should be disabled" flag of its own.
		json needs = json::object();
		{
			const bool shPresent = ModPresent("SunHelmSurvival.esp");
			float      on = 1.0f;
			const bool haveEnabled = GlobalValue("_SHEnabled", on);
			json meters = json::array();
			if (shPresent) {
				PushNeed(meters, "hunger", "Hunger", "_SHCurrentHungerLevel",
					nullptr, "_SHHungerShouldBeDisabled");
				PushNeed(meters, "thirst", "Thirst", "_SHCurrentThirstLevel",
					nullptr, "_SHThirstShouldBeDisabled");
				PushNeed(meters, "fatigue", "Fatigue", "_SHCurrentFatigueLevel",
					nullptr, "_SHFatigueShouldBeDisabled");
				PushNeed(meters, "cold", "Cold", "_SHCurrentColdLevel",
					"_SHColdLevelCap", "_SHColdShouldBeDisabled");
			}
			float warm = 0.0f, freezing = 0.0f, temp = 0.0f;
			needs = json{
				{ "present", shPresent },
				{ "mod", "SunHelm Survival" },
				{ "enabled", !haveEnabled || on != 0.0f },
				{ "meters", std::move(meters) },
				// Context the numbers alone do not give: standing at a fire, or
				// in freezing water, changes what you should do about them.
				{ "nearHeat", GlobalValue("_SHIsNearHeatSource", warm) && warm != 0.0f },
				{ "inFreezingWater", GlobalValue("_SHIsInFreezingWater", freezing) && freezing != 0.0f },
			};
			if (GlobalValue("_SHAmbientTemperature", temp))
				needs["ambient"] = temp;
		}

		// ---- Stats: the deep read ------------------------------------------
		json statGroups = json::array();
		{
			const bool sh = ModPresent("SunHelmSurvival.esp");
			if (sh) {
				// Why you are cold — the whole calculation, which the game shows
				// you as one word and a widget colour.
				json temp = json::array();
				StatRow(temp, "Ambient now", "_SHAmbientTemperature");
				StatRow(temp, "This region", "_SHRegionTemperature");
				StatRow(temp, "This weather", "_SHWeatherTemperature");
				StatRow(temp, "Comfortable at", "_SHComfTemp");
				StatRow(temp, "Cool below", "_SHCoolTemp");
				StatRow(temp, "Freezing below", "_SHFreezingTemp");
				StatRow(temp, "Warm above", "_SHWarmTemp");
				StatRow(temp, "Night penalty (cool)", "_SHCoolNightPen");
				StatRow(temp, "Night penalty (freezing)", "_SHFreezingNightPen");
				StatRow(temp, "Heat source radius", "_SHNormalSourceRadius");
				StatGroup(statGroups, "Temperature", std::move(temp),
					"SunHelm's own numbers - what it adds up before deciding you are cold");

				// How fast you are burning. Nothing in game shows a rate.
				json rates = json::array();
				StatRow(rates, "Hunger rate", "_SHHungerRate", nullptr, false);
				StatRow(rates, "Thirst rate", "_SHThirstRate", nullptr, false);
				StatRow(rates, "Fatigue rate", "_SHFatigueRate", nullptr, false);
				StatRow(rates, "Cold level cap", "_SHColdLevelCap");
				StatRow(rates, "Sleep restores", "_SHFatigueSleepRestoreAmount");
				StatRow(rates, "Drinks per skin", "_SHNumDrinks");
				StatGroup(statGroups, "Rates", std::move(rates),
					"Higher rate = it drains faster");

				// Nine perks, ranked, that only the perk menu ever shows.
				json perks = json::array();
				StatRow(perks, "Unyielding", "_SH_PerkRank_Unyielding");
				StatRow(perks, "Hydrated", "_SH_PerkRank_Hydrated");
				StatRow(perks, "Slumber", "_SH_PerkRank_Slumber");
				StatRow(perks, "Thermal Intensity", "_SH_PerkRank_ThermalIntensity");
				StatRow(perks, "Connoisseur", "_SH_PerkRank_Connoisseur");
				StatRow(perks, "Reservoir", "_SH_PerkRank_Reservoir");
				StatRow(perks, "Repose", "_SH_PerkRank_Repose");
				StatRow(perks, "Ambient Warmth", "_SH_PerkRank_AmbientWarmth");
				StatRow(perks, "Conviviality", "_SH_PerkRank_Conviviality");
				StatGroup(statGroups, "SunHelm perks", std::move(perks));
			}

			if (hunterborn) {
				json hb = json::array();
				StatRow(hb, "Skinning level", "_DS_Hunterborn_SkinLevel");
				StatRow(hb, "Skinning exp", "_DS_Hunterborn_SkinExp");
				StatRow(hb, "Harvest level", "_DS_Hunterborn_HarvestLevel");
				StatRow(hb, "Harvest exp", "_DS_Hunterborn_HarvestExp");
				StatRow(hb, "Forage level", "_DS_Hunterborn_ForageLevel");
				StatRow(hb, "Forage exp", "_DS_Hunterborn_ForageExp");
				StatRow(hb, "Brewing level", "_DS_Hunterborn_BrewLevel");
				StatRow(hb, "Carcasses skinned", "_DS_Hunterborn_SkinningDone");
				StatRow(hb, "Harvests", "_DS_Hunterborn_HarvestingDone");
				StatRow(hb, "Cleans", "_DS_Hunterborn_TotalCleans");
				StatGroup(statGroups, "Hunterborn", std::move(hb),
					"Its four skills, with the exp behind each level");
			}

			if (campfire) {
				json cf = json::array();
				StatRow(cf, "Perk points unspent", "CampingPerkPoints");
				StatRow(cf, "Perk points earned", "CampingPerkPointsEarned");
				StatRow(cf, "Progress to the next", "CampingPerkPointProgress", nullptr, false);
				StatRow(cf, "Can buy one now", "CampfireIsPerkEligibleToBuy", "1 = yes");
				StatRow(cf, "Placements refused", "_Camp_PlacementErrorCounter",
					"how often it said no to a spot");
				StatGroup(statGroups, "Campfire", std::move(cf),
					"Perk progress is invisible in game until the menu tells you");
			}
		}

		// ---- the hero -------------------------------------------------------
		json hero = json::object();
		{
			json blocks = json::array();

			float days = 0.0f;
			if (GlobalValue("GameDaysPassed", days)) {
				json nums = json::array();
				nums.push_back(json{ { "label", "Days survived" },
					{ "value", std::floor(days) } });
				blocks.push_back(json{ { "id", "days" }, { "label", "This life" },
					{ "nums", std::move(nums) }, { "bars", json::array() } });
			}

			if (hunterborn) {
				json nums = json::array(), bars = json::array();
				PushStatNum(nums, "Skinned", "_DS_Hunterborn_SkinningDone");
				PushStatNum(nums, "Harvested", "_DS_Hunterborn_HarvestingDone");
				PushStatNum(nums, "Cleaned", "_DS_Hunterborn_TotalCleans");
				// Levels are real; their exp curve is not published, so the level
				// is a number and there is no bar pretending to know the rest.
				PushStatNum(nums, "Skinning lvl", "_DS_Hunterborn_SkinLevel");
				PushStatNum(nums, "Harvest lvl", "_DS_Hunterborn_HarvestLevel");
				PushStatNum(nums, "Forage lvl", "_DS_Hunterborn_ForageLevel");
				if (!nums.empty() || !bars.empty())
					blocks.push_back(json{ { "id", "hunterborn" }, { "label", "Hunterborn" },
						{ "nums", std::move(nums) }, { "bars", std::move(bars) } });
			}

			if (campfire) {
				json nums = json::array(), bars = json::array();
				PushStatNum(nums, "Perk points", "CampingPerkPoints");
				PushStatNum(nums, "Earned", "CampingPerkPointsEarned");
				// Each perk against its OWN published max — a bar that means it.
				PushStatBar(bars, "Firecraft", "_Camp_PerkRank_Firecraft", "_Camp_PerkRank_Firecraft_Max");
				PushStatBar(bars, "Resourceful", "_Camp_PerkRank_Resourceful", "_Camp_PerkRank_Resourceful_Max");
				PushStatBar(bars, "Trailblazer", "_Camp_PerkRank_Trailblazer", "_Camp_PerkRank_Trailblazer_Max");
				PushStatBar(bars, "High Spirits", "_Camp_PerkRank_HighSpirits", "_Camp_PerkRank_HighSpirits_Max");
				PushStatBar(bars, "Keen Senses", "_Camp_PerkRank_KeenSenses", "_Camp_PerkRank_KeenSenses_Max");
				if (!nums.empty() || !bars.empty())
					blocks.push_back(json{ { "id", "campfire" }, { "label", "Campfire" },
						{ "nums", std::move(nums) }, { "bars", std::move(bars) } });
			}

			hero = json{ { "blocks", std::move(blocks) } };
			hero["statGroups"] = std::move(statGroups);
		}

		return Dump(json{
			{ "ok", true },
			{ "hero", std::move(hero) },
			{ "camp", json{ { "present", campfire }, { "tentapalooza", tenta },
							{ "unleashed", unleashed }, { "hunterborn", hunterborn } } },
			{ "water", json{ { "present", waterMod } } },
			{ "needs", std::move(needs) },
			{ "sections", std::move(sections) } });
	}

	std::string ActJson(const std::string& req)
	{
		const auto refuse = [](const std::string& msg) {
			return Dump(json{ { "ok", false }, { "msg", msg }, { "close", false } });
		};
		const auto j = json::parse(req, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return refuse("Bad request");

		const std::string id = j.value("id", std::string());
		const std::string verb = j.value("verb", std::string("use"));
		const auto        bar = id.find('|');
		std::string plugin, hex;
		if (bar != std::string::npos && bar > 0 && bar + 1 < id.size()) {
			plugin = id.substr(0, bar);
			hex = id.substr(bar + 1);
		} else if (verb != "key" && verb != "smart") {
			// Only the key relay is allowed to carry a non-form id; everything
			// else resolves a real record and must say so when it cannot.
			return refuse("That row has no usable id");
		}

		if (verb == "smart") {
			// Re-pick at PRESS time (the smart-button law): the strongest thing
			// you carry now, not what was strongest when the menu opened. Water
			// ranks by drinks per bottle, food by its restore magnitude - and
			// both are drunk/eaten with the same EquipObject as every other row.
			auto* player = RE::PlayerCharacter::GetSingleton();
			auto* eqm = RE::ActorEquipManager::GetSingleton();
			if (!player || !eqm)
				return refuse("No player");
			const bool wantWater = id.find("water") != std::string::npos;
			RE::AlchemyItem* best = nullptr;
			float bestScore = -1.0f;
			auto inv = player->GetInventory([](RE::TESBoundObject& o) {
				return o.Is(RE::FormType::AlchemyItem);
			});
			for (auto& [obj, data] : inv) {
				if (!obj || data.first <= 0)
					continue;
				auto* alch = obj->As<RE::AlchemyItem>();
				if (!alch)
					continue;
				const auto kind = Hotbar::ClassifyConsumable(alch);
				if (wantWater) {
					if (kind != Hotbar::ConsumableKind::kWater)
						continue;
					const char* nm = alch->GetName();
					const std::string ln = Lower(nm ? nm : "");
					if (LooksSalt(ln, EdidLower(alch)))
						continue;   // never hand someone salt water on purpose
					const float score = static_cast<float>(Hotbar::WaterDrinks(alch));
					if (score > bestScore) { bestScore = score; best = alch; }
				} else {
					if (kind != Hotbar::ConsumableKind::kFood)
						continue;
					float mag = 0.0f;
					for (const auto* eff : alch->effects)
						if (eff && eff->effectItem.magnitude > mag)
							mag = eff->effectItem.magnitude;
					if (mag > bestScore) { bestScore = mag; best = alch; }
				}
			}
			if (!best)
				return refuse(wantWater ? "No drinkable water on you (salt water doesn't count)"
										: "No food on you");
			const char* bn = best->GetName();
			const std::string bname = (bn && *bn) ? bn : (wantWater ? "water" : "food");
			eqm->EquipObject(player, best);
			logger::info("survival: smart {} -> '{}'", wantWater ? "water" : "food", bname);
			return Dump(json{ { "ok", true },
				{ "msg", (wantWater ? "Drank " : "Ate ") + bname }, { "close", false } });
		}

		if (verb == "key") {
			// The deck cannot press a key while its own palette owns input, so
			// this hands the code back and main.cpp fires it AFTER the close —
			// the same order every keystroke entry uses.
			const int key = j.value("key", 0);
			if (key <= 0 || key > 255)
				return refuse("That action has no key set in the mod's own options");
			logger::info("survival: relaying the mod's own key {:#x}", key);
			return Dump(json{ { "ok", true }, { "msg", "Over to the mod" },
				{ "close", true }, { "keyTap", key } });
		}

		if (verb == "cast") {
			// Self-cast the MOD'S OWN power and get out of the way — its magic
			// effect runs its Papyrus from there (the AddItemMenu precedent). The
			// palette closes because these open the mod's own menus, which cannot
			// draw under ours.
			auto* dh2 = RE::TESDataHandler::GetSingleton();
			std::uint32_t local2 = 0;
			try {
				local2 = static_cast<std::uint32_t>(std::stoul(hex, nullptr, 16));
			} catch (...) {
				return refuse("That action's id is malformed");
			}
			auto* spell = dh2 ? dh2->LookupForm<RE::SpellItem>(local2, plugin) : nullptr;
			if (!spell)
				return refuse("That mod's power is gone - is the plugin still enabled?");
			auto* player = RE::PlayerCharacter::GetSingleton();
			auto* caster = player ? player->GetMagicCaster(RE::MagicSystem::CastingSource::kInstant) : nullptr;
			if (!caster)
				return refuse("The caster isn't up");
			caster->CastSpellImmediate(spell, false, player, 1.0f, false, 0.0f, player);
			const char* sn = spell->GetName();
			logger::info("survival: cast '{}' ({}|{})", (sn && *sn) ? sn : "power", plugin, hex);
			return Dump(json{ { "ok", true },
				{ "msg", std::string((sn && *sn) ? sn : "Done") + " - over to the mod" },
				{ "close", true } });
		}

		if (verb == "camp") {
			// Straight through Settlement's own camp placement — i.e. Campfire's
			// equip flow. Never a second implementation: whatever Campfire does
			// with perks, weather and survival hooks happens exactly once, in the
			// mod that owns it. It closes the menu because the placement UI it
			// hands you cannot work under a paused palette.
			const std::string res = Settlement::ExecuteAct(
				Dump(json{ { "id", id }, { "op", "campplace" } }));
			auto out = json::parse(res, nullptr, false);
			if (out.is_discarded() || !out.is_object())
				return refuse("Campfire didn't answer");
			out["close"] = true;
			return Dump(out);
		}

		auto* dh = RE::TESDataHandler::GetSingleton();
		if (!dh)
			return refuse("No data handler");
		std::uint32_t local = 0;
		try {
			local = static_cast<std::uint32_t>(std::stoul(hex, nullptr, 16));
		} catch (...) {
			return refuse("That row's id is malformed");
		}
		auto* form = dh->LookupForm(local, plugin);
		auto* alch = form ? form->As<RE::AlchemyItem>() : nullptr;
		if (!alch)
			return refuse("That item's mod is off, or the form is gone");

		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player)
			return refuse("No save loaded");
		const std::int32_t have = CarriedCount(alch);
		if (have <= 0)
			return refuse("You aren't carrying any more of it");
		auto* eqm = RE::ActorEquipManager::GetSingleton();
		if (!eqm)
			return refuse("The equip manager isn't up");

		const char* nm = alch->GetName();
		const std::string name = (nm && *nm) ? nm : "it";
		// EquipObject IS the eat/drink — the wheel's own verb, so the mod's
		// OnEquipped (SunHelm's thirst, CACO's effects) runs as it should.
		eqm->EquipObject(player, alch);
		logger::info("survival: use '{}' ({} carried before)", name, have);
		return Dump(json{ { "ok", true }, { "msg", "Used " + name },
			{ "id", id }, { "newCount", have - 1 }, { "close", false } });
	}
}
