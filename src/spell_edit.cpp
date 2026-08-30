// Spell Edit — see spell_edit.h for the contract. Structure mirrors
// item_edit.cpp deliberately: same identity idiom, same sidecar shape, same
// orig-capture/revert law — one architecture, three editors (items, spells,
// and transmog's per-instance pool).

#include "spell_edit.h"

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

namespace SpellEdit
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
				return {};
			const std::uint32_t local =
				form->GetFormID() & (file->IsLight() ? 0xFFFu : 0xFFFFFFu);
			char buf[16];
			std::snprintf(buf, sizeof(buf), "%06X", local);
			return std::string(file->GetFilename()) + "|" + buf;
		}

		RE::SpellItem* Resolve(const Spec& s)
		{
			auto* dh = RE::TESDataHandler::GetSingleton();
			return dh ? dh->LookupForm<RE::SpellItem>(s.localId, s.plugin) : nullptr;
		}

		// ------------------------------------------------------------- store --
		json g_edits = json::object();
		bool g_loaded = false;

		std::filesystem::path SidecarPath()
		{
			return std::filesystem::path("Data") / "SKSE" / "Plugins" / "HotkeyDeck" / "spell-edits.json";
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
					logger::info("spell-edit: sidecar loaded - {} edited spell(s)", g_edits.size());
				}
			} catch (...) {
				logger::warn("spell-edit: sidecar unreadable - starting empty (file kept)");
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
					logger::warn("spell-edit: could not write {}", PathU8(tmp));
					return;
				}
				out << Dump(json{ { "v", 1 }, { "edits", g_edits } });
			}
			std::filesystem::rename(tmp, path, ec);
			if (ec)
				logger::warn("spell-edit: sidecar rename failed: {}", ec.message());
		}

		// ------------------------------------------------------------ shapes --
		const char* TypeLabel(RE::MagicSystem::SpellType t)
		{
			using T = RE::MagicSystem::SpellType;
			switch (t) {
			case T::kSpell:       return "Spell";
			case T::kPower:       return "Power";
			case T::kLesserPower: return "Lesser Power";
			case T::kVoicePower:  return "Shout effect";
			case T::kAbility:     return "Ability";
			default:              return "";
			}
		}

		const char* SchoolLabel(RE::ActorValue av)
		{
			using AV = RE::ActorValue;
			switch (av) {
			case AV::kAlteration:  return "Alteration";
			case AV::kConjuration: return "Conjuration";
			case AV::kDestruction: return "Destruction";
			case AV::kIllusion:    return "Illusion";
			case AV::kRestoration: return "Restoration";
			default:               return "";
			}
		}

		// A spell the picker offers: named, resolvable, of a player-meaningful
		// type, with at least one effect.
		bool Offerable(RE::SpellItem* sp)
		{
			if (!sp || !sp->GetFile(0))
				return false;
			const char* nm = sp->GetName();
			if (!nm || !*nm)
				return false;
			using T = RE::MagicSystem::SpellType;
			const auto t = sp->GetSpellType();
			if (t != T::kSpell && t != T::kPower && t != T::kLesserPower &&
				t != T::kVoicePower && t != T::kAbility)
				return false;
			return !sp->effects.empty();
		}

		// The spell's own school = its costliest effect's associated skill —
		// good enough for a hue chip; nameless when none applies.
		std::string SchoolOf(RE::SpellItem* sp)
		{
			for (auto* eff : sp->effects) {
				if (eff && eff->baseEffect)
					if (const char* s = SchoolLabel(eff->baseEffect->data.associatedSkill); *s)
						return s;
			}
			return "";
		}

		json EffectsJson(RE::SpellItem* sp)
		{
			json out = json::array();
			int  i = 0;
			for (auto* eff : sp->effects) {
				if (i >= 24)
					break;
				if (!eff || !eff->baseEffect) {
					++i;
					continue;
				}
				auto*       base = eff->baseEffect;
				const char* nm = base->GetName();
				std::string name = (nm && *nm) ? nm : "";
				if (name.empty()) {
					const char* eid = base->GetFormEditorID();
					name = (eid && *eid) ? eid : ("Effect " + std::to_string(i));
				}
				out.push_back(json{
					{ "i", i },
					{ "n", name },
					{ "mag", eff->effectItem.magnitude },
					{ "dur", eff->effectItem.duration },
					{ "area", eff->effectItem.area },
					{ "harm", base->IsDetrimental() },
					{ "school", SchoolLabel(base->data.associatedSkill) },
				});
				++i;
			}
			return out;
		}

		// One per-effect edit blob {mag?,dur?,area?} applied onto effect #i.
		// Returns fields written.
		int WriteEffect(RE::SpellItem* sp, int i, const json& v)
		{
			if (i < 0 || static_cast<std::size_t>(i) >= sp->effects.size())
				return 0;
			auto* eff = sp->effects[static_cast<std::uint32_t>(i)];
			if (!eff)
				return 0;
			int n = 0;
			if (v.contains("mag") && v["mag"].is_number()) {
				eff->effectItem.magnitude =
					static_cast<float>(std::clamp(v["mag"].get<double>(), 0.0, 1.0e6));
				++n;
			}
			if (v.contains("dur") && v["dur"].is_number()) {
				eff->effectItem.duration =
					static_cast<std::int32_t>(std::clamp(v["dur"].get<double>(), 0.0, 1.0e6));
				++n;
			}
			if (v.contains("area") && v["area"].is_number()) {
				eff->effectItem.area =
					static_cast<std::int32_t>(std::clamp(v["area"].get<double>(), 0.0, 1.0e6));
				++n;
			}
			return n;
		}

		json ReadEffect(RE::SpellItem* sp, int i)
		{
			if (i < 0 || static_cast<std::size_t>(i) >= sp->effects.size())
				return json();
			auto* eff = sp->effects[static_cast<std::uint32_t>(i)];
			if (!eff)
				return json();
			return json{ { "mag", eff->effectItem.magnitude },
				{ "dur", eff->effectItem.duration },
				{ "area", eff->effectItem.area } };
		}

		json StateFor(RE::SpellItem* sp, const std::string& id)
		{
			LoadStore();
			json out;
			out["ok"] = true;
			out["id"] = id;
			const char* nm = sp->GetName();
			out["n"] = std::string(nm ? nm : "");
			if (auto* file = sp->GetFile(0))
				out["plugin"] = std::string(file->GetFilename());
			out["type"] = TypeLabel(sp->GetSpellType());
			out["school"] = SchoolOf(sp);
			out["cost"] = sp->CalculateMagickaCost(RE::PlayerCharacter::GetSingleton());
			out["effects"] = EffectsJson(sp);
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

		// A per-effect blob equals its original when every present number
		// matches (epsilon for the float magnitude).
		bool SameBlob(const json& a, const json& b)
		{
			auto num = [](const json& j, const char* k) -> double {
				return j.contains(k) && j[k].is_number() ? j[k].get<double>() : -1.0;
			};
			return std::fabs(num(a, "mag") - num(b, "mag")) < 1e-3 &&
			       std::fabs(num(a, "dur") - num(b, "dur")) < 1e-3 &&
			       std::fabs(num(a, "area") - num(b, "area")) < 1e-3;
		}
	}

	// ================================================================ API ==

	std::string QueryJson(const std::string& req)
	{
		json in = json::object();
		try {
			in = json::parse(req);
		} catch (...) {}
		const std::string q = in.value("q", std::string(""));
		const int         seq = in.value("seq", 0);
		const int         limit = std::clamp(in.value("limit", 40), 1, 100);

		auto* dh = RE::TESDataHandler::GetSingleton();
		if (!dh)
			return Dump(json{ { "seq", seq }, { "total", 0 }, { "spells", json::array() } });

		// Tokenised match over name + plugin, item_explorer's scoring spirit
		// (prefix beats word-start beats substring) collapsed to one pass.
		std::vector<std::string> tokens;
		{
			std::string cur;
			for (char c : Lower(q)) {
				if (std::isspace(static_cast<unsigned char>(c))) {
					if (!cur.empty()) { tokens.push_back(cur); cur.clear(); }
				} else {
					cur += c;
				}
			}
			if (!cur.empty())
				tokens.push_back(cur);
		}

		struct Hit { int score; RE::SpellItem* sp; std::string lower; };
		std::vector<Hit> hits;
		for (auto* sp : dh->GetFormArray<RE::SpellItem>()) {
			if (!Offerable(sp))
				continue;
			const std::string low = Lower(sp->GetName());
			auto*             file = sp->GetFile(0);
			const std::string plow = Lower(std::string(file->GetFilename()));
			int               score = 0;
			bool              ok = true;
			for (const auto& tok : tokens) {
				const auto pos = low.find(tok);
				if (pos == 0)
					score += 0;
				else if (pos != std::string::npos)
					score += (low[pos - 1] == ' ' || low[pos - 1] == '(') ? 1 : 2;
				else if (plow.find(tok) != std::string::npos)
					score += 4;
				else { ok = false; break; }
			}
			if (!ok)
				continue;
			hits.push_back(Hit{ score, sp, low });
		}
		std::sort(hits.begin(), hits.end(), [](const Hit& a, const Hit& b) {
			if (a.score != b.score)
				return a.score < b.score;
			if (a.lower.size() != b.lower.size())
				return a.lower.size() < b.lower.size();
			return a.lower < b.lower;
		});

		LoadStore();
		json rows = json::array();
		for (const auto& h : hits) {
			if (static_cast<int>(rows.size()) >= limit)
				break;
			const std::string id = IdOf(h.sp);
			if (id.empty())
				continue;
			rows.push_back(json{
				{ "id", id },
				{ "n", std::string(h.sp->GetName()) },
				{ "type", TypeLabel(h.sp->GetSpellType()) },
				{ "school", SchoolOf(h.sp) },
				{ "p", std::string(h.sp->GetFile(0)->GetFilename()) },
				{ "effs", h.sp->effects.size() },
				{ "edited", g_edits.contains(id) },
			});
		}
		return Dump(json{ { "seq", seq }, { "total", hits.size() }, { "spells", std::move(rows) } });
	}

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
			return Dump(Fail("Malformed spell id"));
		auto* sp = Resolve(*spec);
		if (!sp)
			return Dump(Fail(spec->plugin + " has no such spell any more"));
		return Dump(StateFor(sp, id));
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
			return Dump(Fail("Malformed spell id"));
		auto* sp = Resolve(*spec);
		if (!sp)
			return Dump(Fail(spec->plugin + " has no such spell any more"));
		if (!in.contains("set") || !in["set"].is_object())
			return Dump(Fail("Nothing to change"));

		json& entry = g_edits[id];
		if (!entry.is_object())
			entry = json::object();
		if (!entry.contains("set") || !entry["set"].is_object())
			entry["set"] = json::object();
		if (!entry.contains("orig") || !entry["orig"].is_object())
			entry["orig"] = json::object();

		int applied = 0;
		for (auto it = in["set"].begin(); it != in["set"].end(); ++it) {
			const std::string key = it.key();   // "e<idx>"
			if (key.size() < 2 || key[0] != 'e' || !it.value().is_object())
				continue;
			const int i = std::atoi(key.c_str() + 1);
			const bool hadOrig = entry["orig"].contains(key);
			json       before;
			if (!hadOrig)
				before = ReadEffect(sp, i);
			const int n = WriteEffect(sp, i, it.value());
			if (!n)
				continue;
			if (!hadOrig && !before.is_null())
				entry["orig"][key] = before;
			// The blob the caller sent may be partial ({mag} only) — store the
			// effect's full CURRENT state so replay restores all three numbers.
			const json now = ReadEffect(sp, i);
			if (entry["orig"].contains(key) && SameBlob(entry["orig"][key], now)) {
				entry["set"].erase(key);
				entry["orig"].erase(key);
			} else {
				entry["set"][key] = now;
			}
			applied += n;
		}
		if (!applied) {
			if (entry["set"].empty())
				g_edits.erase(id);
			return Dump(Fail("No editable effect in that request"));
		}

		const char* nm = sp->GetName();
		entry["n"] = std::string(nm ? nm : "");
		if (entry["set"].empty())
			g_edits.erase(id);
		SaveStore();
		logger::info("spell-edit: applied {} value(s) to '{}'", applied, id);

		json out = StateFor(sp, id);
		out["msg"] = g_edits.contains(id)
			? std::string("Changed - saved across launches")
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
			return Dump(Fail("That spell carries no edits"));
		const auto spec = ParseId(id);
		auto*      sp = spec ? Resolve(*spec) : nullptr;
		if (!sp) {
			g_edits.erase(id);
			SaveStore();
			return Dump(json{ { "ok", true }, { "id", id },
				{ "msg", "Spell is gone from the load order - edit record dropped" } });
		}
		int n = 0;
		if (g_edits[id].contains("orig") && g_edits[id]["orig"].is_object()) {
			for (auto it = g_edits[id]["orig"].begin(); it != g_edits[id]["orig"].end(); ++it) {
				if (it.key().size() < 2 || it.key()[0] != 'e')
					continue;
				n += WriteEffect(sp, std::atoi(it.key().c_str() + 1), it.value());
			}
		}
		g_edits.erase(id);
		SaveStore();
		logger::info("spell-edit: reverted {} value(s) on '{}'", n, id);
		json out = StateFor(sp, id);
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

	void ReapplyAll()
	{
		LoadStore();
		if (g_edits.empty())
			return;
		int spells = 0, values = 0, missing = 0;
		for (auto it = g_edits.begin(); it != g_edits.end(); ++it) {
			const auto& e = it.value();
			if (!e.is_object() || !e.contains("set") || !e["set"].is_object())
				continue;
			const auto spec = ParseId(it.key());
			auto*      sp = spec ? Resolve(*spec) : nullptr;
			if (!sp) {
				++missing;
				continue;
			}
			bool any = false;
			for (auto f = e["set"].begin(); f != e["set"].end(); ++f) {
				if (f.key().size() < 2 || f.key()[0] != 'e')
					continue;
				const int n = WriteEffect(sp, std::atoi(f.key().c_str() + 1), f.value());
				if (n) {
					values += n;
					any = true;
				}
			}
			if (any)
				++spells;
		}
		logger::info("spell-edit: reapplied {} value(s) on {} spell(s){}", values, spells,
			missing ? " (" + std::to_string(missing) + " missing from the load order, kept)" : "");
	}
}
