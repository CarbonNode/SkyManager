// Item Edit — base-record editor behind the Finder's Modify sheet. See
// item_edit.h for the contract and proteus_item_modification.md for the
// PROTEUS teardown this design answers.
//
// Design notes that are load-bearing:
//  - Field writes are the transmog.cpp idiom verbatim (fullName from c_str,
//    armorRating in record units = display x100, criticalData.damage,
//    weaponData.speed/reach/staggerValue) — one proven write path, two users.
//  - The sidecar keys edits by "Plugin.esp|LOCALHEX" (file-width-masked local
//    id), NOT by display name — PROTEUS keys by name and collides on every
//    duplicate "Iron Sword"; renaming an item must not orphan its own edit.
//  - orig captures the PRE-EDIT value the first time each field is touched and
//    is never overwritten after, so revert restores the load order's truth
//    even after five successive edits. A set value that lands back on its
//    orig is DROPPED from the entry (and an entry with nothing set is
//    removed), so the pane's "edited" chip can never lie.
//  - All JSON is dumped with error_handler_t::replace — names come out of
//    arbitrary ESPs and player input, and are not guaranteed UTF-8.

#include "item_edit.h"

#include "pch.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <optional>
#include <string>
#include <vector>

namespace ItemEdit
{
	namespace
	{
		using json = nlohmann::json;

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

		// ---------------------------------------------------------- identity --
		struct Spec
		{
			std::string   plugin;
			std::uint32_t localId = 0;
		};

		std::optional<Spec> ParseId(const std::string& id)
		{
			const auto bar = id.find('|');
			if (bar == std::string::npos || bar == 0 || bar + 1 >= id.size())
				return std::nullopt;
			Spec s;
			s.plugin = id.substr(0, bar);
			s.localId = static_cast<std::uint32_t>(std::strtoul(id.c_str() + bar + 1, nullptr, 16));
			return s;
		}

		std::string IdOf(const RE::TESForm* form)
		{
			if (!form)
				return {};
			auto* file = form->GetFile(0);
			if (!file)
				return {};  // dynamic (0xFF…) — not durable, not editable
			const std::uint32_t local =
				form->GetFormID() & (file->IsLight() ? 0xFFFu : 0xFFFFFFu);
			char buf[16];
			std::snprintf(buf, sizeof(buf), "%06X", local);
			return std::string(file->GetFilename()) + "|" + buf;
		}

		RE::TESBoundObject* Resolve(const Spec& s)
		{
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh)
				return nullptr;
			auto* form = dh->LookupForm(s.localId, s.plugin);
			return form ? form->As<RE::TESBoundObject>() : nullptr;
		}

		// ------------------------------------------------------------- store --
		// g_edits mirrors the sidecar exactly:
		//   { "<id>": { "kind": "...", "n": "...", "set": {...}, "orig": {...} } }
		// set/orig share one key space: name value weight damage crit speed
		// reach stagger armor charge ench. ench is "Plugin|HEX" or "none".
		json g_edits = json::object();
		bool g_loaded = false;

		std::filesystem::path SidecarPath()
		{
			return std::filesystem::path("Data") / "SKSE" / "Plugins" / "HotkeyDeck" / "item-edits.json";
		}

		void LoadStore()
		{
			if (g_loaded)
				return;
			g_loaded = true;
			std::ifstream in(SidecarPath(), std::ios::binary);
			if (!in)
				return;
			try {
				json j = json::parse(in, nullptr, true, true);
				if (j.is_object() && j.value("v", 0) == 1 && j["edits"].is_object()) {
					g_edits = j["edits"];
					logger::info("item-edit: sidecar loaded - {} edited item(s)", g_edits.size());
				}
			} catch (...) {
				logger::warn("item-edit: sidecar unreadable - starting empty (file kept)");
			}
		}

		void SaveStore()
		{
			const auto path = SidecarPath();
			std::error_code ec;
			std::filesystem::create_directories(path.parent_path(), ec);
			auto tmp = path;
			tmp += ".tmp";
			{
				std::ofstream out(tmp, std::ios::trunc | std::ios::binary);
				if (!out.is_open()) {
					logger::warn("item-edit: could not write {}", PathU8(tmp));
					return;
				}
				out << Dump(json{ { "v", 1 }, { "edits", g_edits } });
			}
			std::filesystem::rename(tmp, path, ec);
			if (ec)
				logger::warn("item-edit: sidecar rename failed: {}", ec.message());
		}

		// ------------------------------------------------------------ fields --
		const char* KindOf(RE::TESBoundObject* b)
		{
			if (b->As<RE::TESObjectWEAP>())
				return "weap";
			if (b->As<RE::TESObjectARMO>())
				return "armo";
			if (b->As<RE::TESAmmo>())
				return "ammo";
			return "other";
		}

		// Current value of one field, in DISPLAY units. nullopt = the field does
		// not exist on this form (the view hides the row).
		std::optional<json> ReadField(RE::TESBoundObject* b, const std::string& key)
		{
			if (key == "name") {
				const char* nm = b->GetName();
				return json(std::string(nm ? nm : ""));
			}
			if (key == "value")
				return json(b->GetGoldValue());
			if (key == "weight")
				return json(b->GetWeight());
			if (key == "ench" || key == "charge") {
				auto* en = b->As<RE::TESEnchantableForm>();
				if (!en)
					return std::nullopt;
				if (key == "charge")
					return json(static_cast<int>(en->amountofEnchantment));
				if (!en->formEnchanting)
					return json(std::string("none"));
				const std::string id = IdOf(en->formEnchanting);
				// A dynamic (player-crafted) base enchantment has no durable id;
				// report it as itself so orig-capture round-trips honestly.
				return json(id.empty() ? std::string("none") : id);
			}
			if (auto* w = b->As<RE::TESObjectWEAP>()) {
				if (key == "damage")
					return json(static_cast<int>(w->attackDamage));
				if (key == "crit")
					return json(static_cast<int>(w->criticalData.damage));
				if (key == "speed")
					return json(w->weaponData.speed);
				if (key == "reach")
					return json(w->weaponData.reach);
				if (key == "stagger")
					return json(w->weaponData.staggerValue);
			}
			if (auto* a = b->As<RE::TESObjectARMO>()) {
				if (key == "armor")
					return json(static_cast<double>(a->armorRating) / 100.0);
			}
			if (auto* am = b->As<RE::TESAmmo>()) {
				// NG: AMMO_DATA sits inside the runtime-relocated block.
				if (key == "damage")
					return json(am->GetRuntimeData().data.damage);
			}
			return std::nullopt;
		}

		// Write one field (display units, clamped to the transmog ranges).
		// Returns false when the field does not apply to this form.
		bool WriteField(RE::TESBoundObject* b, const std::string& key, const json& v)
		{
			auto num = [&](double lo, double hi) -> std::optional<double> {
				if (!v.is_number())
					return std::nullopt;
				return std::clamp(v.get<double>(), lo, hi);
			};
			if (key == "name") {
				if (!v.is_string())
					return false;
				auto s = v.get<std::string>();
				if (s.empty() || s.size() > 200)
					return false;
				if (auto* fn = b->As<RE::TESFullName>()) {
					fn->fullName = s.c_str();
					return true;
				}
				return false;
			}
			if (key == "value") {
				if (auto n = num(0.0, 2.0e9)) {
					if (auto* vf = b->As<RE::TESValueForm>()) {
						vf->value = static_cast<std::int32_t>(*n);
						return true;
					}
				}
				return false;
			}
			if (key == "weight") {
				if (auto n = num(0.0, 10000.0)) {
					if (auto* wf = b->As<RE::TESWeightForm>()) {
						wf->weight = static_cast<float>(*n);
						return true;
					}
				}
				return false;
			}
			if (key == "charge") {
				if (auto n = num(0.0, 65535.0)) {
					if (auto* en = b->As<RE::TESEnchantableForm>()) {
						en->amountofEnchantment = static_cast<std::uint16_t>(*n);
						return true;
					}
				}
				return false;
			}
			if (key == "ench") {
				auto* en = b->As<RE::TESEnchantableForm>();
				if (!en || !v.is_string())
					return false;
				const auto s = v.get<std::string>();
				if (s == "none") {
					en->formEnchanting = nullptr;
					return true;
				}
				const auto spec = ParseId(s);
				if (!spec)
					return false;
				auto* dh = RE::TESDataHandler::GetSingleton();
				auto* e = dh ? dh->LookupForm<RE::EnchantmentItem>(spec->localId, spec->plugin) : nullptr;
				if (!e)
					return false;
				en->formEnchanting = e;
				return true;
			}
			if (auto* w = b->As<RE::TESObjectWEAP>()) {
				if (key == "damage") {
					if (auto n = num(0.0, 65535.0)) { w->attackDamage = static_cast<std::uint16_t>(*n); return true; }
					return false;
				}
				if (key == "crit") {
					if (auto n = num(0.0, 65535.0)) { w->criticalData.damage = static_cast<std::uint16_t>(*n); return true; }
					return false;
				}
				if (key == "speed") {
					if (auto n = num(0.01, 20.0)) { w->weaponData.speed = static_cast<float>(*n); return true; }
					return false;
				}
				if (key == "reach") {
					if (auto n = num(0.01, 20.0)) { w->weaponData.reach = static_cast<float>(*n); return true; }
					return false;
				}
				if (key == "stagger") {
					if (auto n = num(0.0, 10.0)) { w->weaponData.staggerValue = static_cast<float>(*n); return true; }
					return false;
				}
			}
			if (auto* a = b->As<RE::TESObjectARMO>()) {
				if (key == "armor") {
					if (auto n = num(0.0, 10000.0)) {
						// display units -> record units (CK value x100)
						a->armorRating = static_cast<std::uint32_t>(std::lround(*n * 100.0));
						return true;
					}
					return false;
				}
			}
			if (auto* am = b->As<RE::TESAmmo>()) {
				if (key == "damage") {
					if (auto n = num(0.0, 10000.0)) { am->GetRuntimeData().data.damage = static_cast<float>(*n); return true; }
					return false;
				}
			}
			return false;
		}

		// Every field key this form CAN carry — drives both the Get reply's
		// fields object and the apply loop's whitelist.
		std::vector<std::string> FieldKeysFor(RE::TESBoundObject* b)
		{
			std::vector<std::string> keys{ "name", "value", "weight" };
			if (b->As<RE::TESObjectWEAP>()) {
				keys.insert(keys.end(), { "damage", "crit", "speed", "reach", "stagger" });
			} else if (b->As<RE::TESObjectARMO>()) {
				keys.push_back("armor");
			} else if (b->As<RE::TESAmmo>()) {
				keys.push_back("damage");
			}
			if (b->As<RE::TESEnchantableForm>()) {
				keys.push_back("ench");
				keys.push_back("charge");
			}
			return keys;
		}

		// Two field values equal? Numbers compare with a small epsilon so a
		// float that round-trips through JSON does not read as "still edited".
		bool SameValue(const json& a, const json& b)
		{
			if (a.is_number() && b.is_number())
				return std::fabs(a.get<double>() - b.get<double>()) < 1e-4;
			return a == b;
		}

		// ----------------------------------------------------------- replies --
		json StateFor(RE::TESBoundObject* b, const std::string& id)
		{
			LoadStore();
			json fields = json::object();
			for (const auto& key : FieldKeysFor(b)) {
				if (auto v = ReadField(b, key))
					fields[key] = *v;
			}
			json out;
			out["ok"] = true;
			out["id"] = id;
			out["kind"] = KindOf(b);
			const char* nm = b->GetName();
			out["n"] = std::string(nm ? nm : "");
			if (auto* file = b->GetFile(0))
				out["plugin"] = std::string(file->GetFilename());
			out["fields"] = std::move(fields);
			// Current base enchantment, named, so the sheet can show it.
			if (auto* en = b->As<RE::TESEnchantableForm>()) {
				if (auto* e = en->formEnchanting) {
					const char* enm = e->GetName();
					out["ench"] = json{ { "id", IdOf(e) },
						{ "n", std::string(enm && *enm ? enm : "(unnamed enchantment)") } };
				}
			}
			json edited = json::array();
			if (g_edits.contains(id) && g_edits[id].is_object()) {
				const auto& e = g_edits[id];
				if (e.contains("orig"))
					out["orig"] = e["orig"];
				if (e.contains("set") && e["set"].is_object())
					for (auto it = e["set"].begin(); it != e["set"].end(); ++it)
						edited.push_back(it.key());
			}
			out["edited"] = std::move(edited);
			out["count"] = g_edits.size();
			return out;
		}

		json Fail(const std::string& msg)
		{
			return json{ { "ok", false }, { "msg", msg } };
		}
	}

	// ================================================================ API ==

	std::string GetJson(const std::string& req)
	{
		LoadStore();
		json in = json::object();
		try {
			in = json::parse(req);
		} catch (...) {}
		const std::string id = in.value("id", std::string(""));
		const auto        spec = ParseId(id);
		if (!spec)
			return Dump(Fail("Malformed item id"));
		auto* bound = Resolve(*spec);
		if (!bound)
			return Dump(Fail(spec->plugin + " has no such item any more"));
		return Dump(StateFor(bound, id));
	}

	std::string ApplyJson(const std::string& req)
	{
		LoadStore();
		json in = json::object();
		try {
			in = json::parse(req);
		} catch (...) {}
		const std::string id = in.value("id", std::string(""));
		const auto        spec = ParseId(id);
		if (!spec)
			return Dump(Fail("Malformed item id"));
		auto* bound = Resolve(*spec);
		if (!bound)
			return Dump(Fail(spec->plugin + " has no such item any more"));
		if (!in.contains("set") || !in["set"].is_object())
			return Dump(Fail("Nothing to change"));

		json& entry = g_edits[id];
		if (!entry.is_object())
			entry = json::object();
		if (!entry.contains("set") || !entry["set"].is_object())
			entry["set"] = json::object();
		if (!entry.contains("orig") || !entry["orig"].is_object())
			entry["orig"] = json::object();

		const auto allowed = FieldKeysFor(bound);
		int        applied = 0;
		for (const auto& key : allowed) {
			if (!in["set"].contains(key))
				continue;
			const json& v = in["set"][key];
			// Capture the original BEFORE the first write of this field, ever.
			const bool hadOrig = entry["orig"].contains(key);
			json       before;
			if (!hadOrig) {
				if (auto cur = ReadField(bound, key))
					before = *cur;
			}
			if (!WriteField(bound, key, v))
				continue;
			if (!hadOrig && !before.is_null())
				entry["orig"][key] = before;
			// Landed back on the original -> the field is no longer "edited".
			if (entry["orig"].contains(key) && SameValue(entry["orig"][key], v)) {
				entry["set"].erase(key);
				entry["orig"].erase(key);
			} else {
				entry["set"][key] = v;
			}
			++applied;
		}
		if (!applied) {
			if (entry["set"].empty())
				g_edits.erase(id);
			return Dump(Fail("No editable field in that request"));
		}

		entry["kind"] = KindOf(bound);
		const char* nm = bound->GetName();
		entry["n"] = std::string(nm ? nm : "");
		if (entry["set"].empty())
			g_edits.erase(id);   // every change landed back on the originals
		SaveStore();
		logger::info("item-edit: applied {} field(s) to '{}'", applied, id);

		json out = StateFor(bound, id);
		out["msg"] = g_edits.contains(id)
			? std::string("Changed - every copy of it, saved across launches")
			: std::string("Back to its original values");
		return Dump(out);
	}

	std::string RevertJson(const std::string& req)
	{
		LoadStore();
		json in = json::object();
		try {
			in = json::parse(req);
		} catch (...) {}
		const std::string id = in.value("id", std::string(""));
		if (!g_edits.contains(id))
			return Dump(Fail("That item carries no edits"));
		const auto spec = ParseId(id);
		auto*      bound = spec ? Resolve(*spec) : nullptr;
		if (!bound) {
			// Plugin gone: the form cannot be restored, but the stale entry can
			// be dropped so the list stops naming a ghost.
			g_edits.erase(id);
			SaveStore();
			return Dump(json{ { "ok", true }, { "id", id },
				{ "msg", "Item is gone from the load order - edit record dropped" } });
		}
		int n = 0;
		if (g_edits[id].contains("orig") && g_edits[id]["orig"].is_object()) {
			for (auto it = g_edits[id]["orig"].begin(); it != g_edits[id]["orig"].end(); ++it)
				if (WriteField(bound, it.key(), it.value()))
					++n;
		}
		g_edits.erase(id);
		SaveStore();
		logger::info("item-edit: reverted {} field(s) on '{}'", n, id);
		json out = StateFor(bound, id);
		out["msg"] = "Restored to its original values";
		return Dump(out);
	}

	std::string ListJson()
	{
		LoadStore();
		json rows = json::array();
		for (auto it = g_edits.begin(); it != g_edits.end(); ++it) {
			const auto& e = it.value();
			if (!e.is_object())
				continue;
			const auto bar = it.key().find('|');
			rows.push_back(json{
				{ "id", it.key() },
				{ "n", e.value("n", std::string("?")) },
				{ "p", bar == std::string::npos ? std::string("?") : it.key().substr(0, bar) },
				{ "fields", e.contains("set") && e["set"].is_object() ? e["set"].size() : 0 },
			});
		}
		return Dump(json{ { "edits", std::move(rows) }, { "count", g_edits.size() } });
	}

	std::string EnchSearchJson(const std::string& req)
	{
		json in = json::object();
		try {
			in = json::parse(req);
		} catch (...) {}
		const std::string q = Lower(in.value("q", std::string("")));
		const std::string kind = in.value("kind", std::string(""));

		auto* dh = RE::TESDataHandler::GetSingleton();
		if (!dh)
			return Dump(json{ { "ench", json::array() } });

		json out = json::array();
		for (auto* e : dh->GetFormArray<RE::EnchantmentItem>()) {
			if (out.size() >= 60)
				break;
			if (!e)
				continue;
			const char* nm = e->GetName();
			if (!nm || !*nm)
				continue;   // nameless = the internal "base enchantment" variants
			if (!e->GetFile(0))
				continue;   // dynamic (player-crafted) — not durable across launches
			// Weapon enchants strike on hit (touch); armor enchants ride the
			// wearer (self). No kind filter = everything named.
			const auto d = e->data.delivery;
			if (kind == "weap" && d != RE::MagicSystem::Delivery::kTouch)
				continue;
			if (kind == "armo" && d != RE::MagicSystem::Delivery::kSelf)
				continue;
			if (!q.empty() && Lower(nm).find(q) == std::string::npos)
				continue;
			// One-line effect summary: first named effect + its magnitude.
			std::string eff;
			for (auto* fx : e->effects) {
				if (!fx || !fx->baseEffect)
					continue;
				const char* fnm = fx->baseEffect->GetName();
				if (!fnm || !*fnm)
					continue;
				eff = fnm;
				if (fx->effectItem.magnitude > 0.0f)
					eff += " " + std::to_string(static_cast<int>(fx->effectItem.magnitude)) + " pts";
				break;
			}
			out.push_back(json{ { "id", IdOf(e) }, { "n", std::string(nm) }, { "eff", eff } });
		}
		return Dump(json{ { "ench", std::move(out) } });
	}

	void ReapplyAll()
	{
		LoadStore();
		if (g_edits.empty())
			return;
		int items = 0, fields = 0, missing = 0;
		for (auto it = g_edits.begin(); it != g_edits.end(); ++it) {
			const auto& e = it.value();
			if (!e.is_object() || !e.contains("set") || !e["set"].is_object())
				continue;
			const auto spec = ParseId(it.key());
			auto*      bound = spec ? Resolve(*spec) : nullptr;
			if (!bound) {
				// Plugin missing THIS session: keep the entry (it may come back
				// with the mod), just say so once.
				++missing;
				continue;
			}
			bool any = false;
			for (auto f = e["set"].begin(); f != e["set"].end(); ++f) {
				if (WriteField(bound, f.key(), f.value())) {
					++fields;
					any = true;
				}
			}
			if (any)
				++items;
		}
		logger::info("item-edit: reapplied {} field(s) on {} item(s){}", fields, items,
			missing ? " (" + std::to_string(missing) + " missing from the load order, kept)" : "");
	}
}
