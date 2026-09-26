// Spells tab — the Finder's fourth roster. See spell_finder.h for the contract.
//
// Design notes that are load-bearing:
//  - Two sources, one roster: TESDataHandler's SpellItem array (spells, powers,
//    lesser powers, voice powers, abilities) and its TESShout array. Diseases,
//    poisons, addictions, enchantments and scrolls are SpellItems too and are
//    skipped on purpose — this is a spell list, not a form dump.
//  - Identity is (plugin, file-width-masked local FormID) derived from the load
//    index in the runtime id (CellFinder::OwnerFile's lesson), never GetFile(0).
//  - The index walk touches names, editor ids, the icon keys and the cost. What
//    changes under the roster — whether YOU or the crosshair actor know it —
//    is read live per returned row and per detail, never cached.
//  - All JSON dumps use error_handler_t::replace — spell names come out of
//    thousands of third-party plugins and are not guaranteed UTF-8.

#include "spell_finder.h"

#include "pch.h"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <string>
#include <string_view>
#include <unordered_map>
#include <vector>

#include "npc_actions.h"
#include "spell_actions.h"

namespace SpellFinder
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

		// ------------------------------------------------------------- index --
		struct Plugin
		{
			std::string   name;
			std::string   lower;
			std::string   ext;
			bool          light = false;
			std::uint32_t count = 0;
		};

		enum class Kind : std::uint8_t { Spell, Power, Lesser, Voice, Ability, Shout };

		const char* KindName(Kind k)
		{
			switch (k) {
			case Kind::Spell:   return "spell";
			case Kind::Power:   return "power";
			case Kind::Lesser:  return "lesser";
			case Kind::Voice:   return "voice";
			case Kind::Ability: return "ability";
			case Kind::Shout:   return "shout";
			}
			return "spell";
		}

		// The SpellItem types worth a row. Everything else (disease, poison,
		// addiction, enchantment, scroll, potion, leveled) is not a spell a
		// player would look for here.
		bool KindFor(RE::MagicSystem::SpellType t, Kind& out)
		{
			using T = RE::MagicSystem::SpellType;
			switch (t) {
			case T::kSpell:       out = Kind::Spell;   return true;
			case T::kPower:       out = Kind::Power;   return true;
			case T::kLesserPower: out = Kind::Lesser;  return true;
			case T::kVoicePower:  out = Kind::Voice;   return true;
			case T::kAbility:     out = Kind::Ability; return true;
			default:              return false;
			}
		}

		// Worded exactly as spell_actions.cpp words them, so the Spell Deck and
		// this roster agree on what "aimed" and "concentration" mean.
		const char* DeliveryName(RE::MagicSystem::Delivery d)
		{
			using D = RE::MagicSystem::Delivery;
			switch (d) {
			case D::kSelf:           return "self";
			case D::kTouch:          return "touch";
			case D::kAimed:          return "aimed";
			case D::kTargetActor:    return "target";
			case D::kTargetLocation: return "location";
			default:                 return "other";
			}
		}

		const char* CastingName(RE::MagicSystem::CastingType c)
		{
			using C = RE::MagicSystem::CastingType;
			switch (c) {
			case C::kConstantEffect: return "constant";
			case C::kFireAndForget:  return "fire";
			case C::kConcentration:  return "concentration";
			case C::kScroll:         return "scroll";
			default:                 return "other";
			}
		}

		struct Row
		{
			std::uint32_t formId = 0;   // runtime — session-scoped lookups
			std::uint32_t localId = 0;  // durable half of the row identity
			std::uint16_t plug = 0;     // index into g_plugins
			Kind          kind = Kind::Spell;
			bool          hostile = false;
			std::optional<float> cost;  // null when Skyrim cannot safely evaluate it
			std::string   name;
			std::string   edid;         // "" unless the form kept its editor id
			std::string   school, element, archetype, tier, delivery, casting;
			std::string   lname;        // lowercased name
			std::string   ledid;        // lowercased editor id
			std::string   lwords;       // kind + school + element + archetype + tier + delivery + casting, lowercased
		};

		std::vector<Plugin> g_plugins;
		std::vector<Row>    g_rows;
		bool                g_built = false;

		/* Persisted page size only — this module's OWN sidecar, never a
		 * hotkeys.json slice (the OnJsSave wholesale-replace trap). */
		int  g_pageSize = 25;
		bool g_settingsLoaded = false;

		int ClampPageSize(int n)
		{
			return std::clamp(n, 1, 100);
		}

		std::filesystem::path SettingsPath()
		{
			return std::filesystem::path("Data") / "SKSE" / "Plugins" / "HotkeyDeck" / "spell-finder.json";
		}

		void LoadSettings()
		{
			if (g_settingsLoaded)
				return;
			g_settingsLoaded = true;
			std::ifstream in(SettingsPath(), std::ios::binary);
			if (!in)
				return;
			try {
				json j = json::parse(in, nullptr, true, true);
				if (j.is_object())
					g_pageSize = ClampPageSize(j.value("pageSize", g_pageSize));
			} catch (...) {
				logger::warn("spell-finder: settings sidecar unreadable - defaults kept");
			}
		}

		void SaveSettingsFile()
		{
			const auto path = SettingsPath();
			std::error_code ec;
			std::filesystem::create_directories(path.parent_path(), ec);
			auto tmp = path;
			tmp += ".tmp";
			{
				std::ofstream out(tmp, std::ios::trunc | std::ios::binary);
				if (!out.is_open()) {
					logger::warn("spell-finder: cannot write {}", PathU8(path));
					return;
				}
				out << Dump(json{ { "pageSize", g_pageSize } });
			}
			std::filesystem::rename(tmp, path, ec);
			if (ec)
				logger::warn("spell-finder: sidecar rename failed - {}", ec.message());
		}

		// The file a form's identity BELONGS to — the one its load index names
		// (CellFinder's Bannermist lesson: GetFile(0) hands back an override).
		const RE::TESFile* OwnerFile(RE::TESDataHandler* dh, RE::FormID formId)
		{
			if (!dh)
				return nullptr;
			const std::uint32_t hi = formId >> 24;
			if (hi == 0xFF)
				return nullptr;   // dynamic — not a durable spell
			if (hi == 0xFE)
				return dh->LookupLoadedLightModByIndex(static_cast<std::uint16_t>((formId >> 12) & 0xFFFu));
			return dh->LookupLoadedModByIndex(static_cast<std::uint8_t>(hi));
		}

		std::uint16_t PlugIndexFor(const RE::TESFile* file,
			std::unordered_map<const RE::TESFile*, std::uint16_t>& map)
		{
			if (auto it = map.find(file); it != map.end())
				return it->second;
			Plugin p;
			p.name = std::string(file->GetFilename());
			p.lower = Lower(p.name);
			p.light = file->IsLight();
			const auto dot = p.lower.rfind('.');
			p.ext = dot == std::string::npos ? "esp" : p.lower.substr(dot + 1);
			const auto idx = static_cast<std::uint16_t>(g_plugins.size());
			g_plugins.push_back(std::move(p));
			map.emplace(file, idx);
			return idx;
		}

		std::string FullNameOf(RE::TESForm* form)
		{
			if (!form)
				return {};
			if (auto* fn = form->As<RE::TESFullName>()) {
				const char* n = fn->GetFullName();
				if (n && *n)
					return n;
			}
			return {};
		}

		void FinishRow(Row& r)
		{
			r.lname = Lower(r.name);
			r.ledid = Lower(r.edid);
			std::string w = KindName(r.kind);
			if (r.kind == Kind::Power || r.kind == Kind::Lesser || r.kind == Kind::Voice)
				w += " power";
			if (r.kind == Kind::Shout)
				w += " thu'um words voice";
			for (const std::string* s : { &r.school, &r.element, &r.archetype, &r.tier, &r.delivery, &r.casting })
				if (!s->empty()) { w += ' '; w += *s; }
			r.lwords = Lower(w);
		}

		void EnsureIndex()
		{
			if (g_built)
				return;
			g_built = true;
			LoadSettings();
			const auto t0 = std::chrono::steady_clock::now();
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh)
				return;
			std::unordered_map<const RE::TESFile*, std::uint16_t> pmap;
			g_rows.reserve(16384);
			std::uint32_t skipped = 0;

			for (auto* s : dh->GetFormArray<RE::SpellItem>()) {
				if (!s)
					continue;
				const char* nm = s->GetFullName();
				Kind        k;
				if (!nm || !*nm || !KindFor(s->GetSpellType(), k)) {
					++skipped;
					continue;
				}
				auto* file = OwnerFile(dh, s->GetFormID());
				if (!file)
					continue;
				Row r;
				r.formId = s->GetFormID();
				r.localId = r.formId & (file->IsLight() ? 0xFFFu : 0xFFFFFFu);
				r.plug = PlugIndexFor(file, pmap);
				r.kind = k;
				r.name = nm;
				if (const char* ed = s->GetFormEditorID(); ed && *ed)
					r.edid = ed;
				SpellActions::IconMeta(s, r.school, r.element, r.archetype, r.tier);
				r.delivery = DeliveryName(s->GetDelivery());
				r.casting = CastingName(s->GetCastingType());
				r.hostile = s->IsHostile();
				if (k != Kind::Ability) {
					if (const auto cost = SpellActions::MagickaCostForPlayer(s))
						r.cost = std::round(*cost);
				}
				FinishRow(r);
				g_plugins[r.plug].count++;
				g_rows.push_back(std::move(r));
			}
			const std::size_t spells = g_rows.size();

			for (auto* sh : dh->GetFormArray<RE::TESShout>()) {
				if (!sh)
					continue;
				const char* nm = sh->GetFullName();
				if (!nm || !*nm) {
					++skipped;
					continue;
				}
				auto* file = OwnerFile(dh, sh->GetFormID());
				if (!file)
					continue;
				Row r;
				r.formId = sh->GetFormID();
				r.localId = r.formId & (file->IsLight() ? 0xFFFu : 0xFFFFFFu);
				r.plug = PlugIndexFor(file, pmap);
				r.kind = Kind::Shout;
				r.name = nm;
				if (const char* ed = sh->GetFormEditorID(); ed && *ed)
					r.edid = ed;
				// The first word's spell carries the shout's character (delivery,
				// hostility); the shout form itself has neither.
				if (auto* first = sh->variations[0].spell) {
					r.delivery = DeliveryName(first->GetDelivery());
					r.hostile = first->IsHostile();
					std::string tier;
					SpellActions::IconMeta(first, r.school, r.element, r.archetype, tier);
					r.school.clear();   // shouts have no school; the element (fire breath) is worth keeping
				}
				r.casting = "fire";
				FinishRow(r);
				g_plugins[r.plug].count++;
				g_rows.push_back(std::move(r));
			}
			const std::size_t shouts = g_rows.size() - spells;
			const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
				std::chrono::steady_clock::now() - t0).count();
			logger::info("spell-finder: index built - {} spells/powers/abilities + {} shouts across {} plugins in {} ms ({} skipped: unnamed, diseases, poisons, addictions)",
				spells, shouts, g_plugins.size(), ms, skipped);
		}

		// ---------------------------------------------------------- queries --
		std::vector<std::string> Tokens(const std::string& q)
		{
			std::vector<std::string> out;
			std::string cur;
			for (char c : Lower(q)) {
				if (std::isspace(static_cast<unsigned char>(c))) {
					if (!cur.empty()) { out.push_back(cur); cur.clear(); }
				} else {
					cur += c;
				}
			}
			if (!cur.empty())
				out.push_back(cur);
			return out;
		}

		/* 0 best, -1 no match. A name hit outranks an editor-id hit, which
		 * outranks the descriptive words (school, kind, element: "fire",
		 * "destruction", "shout"), which outrank the plugin — so "fire" finds
		 * Firebolt before every spell in a mod called Firestorm. */
		int TokenScore(const Row& r, const Plugin& pl, const std::string& tok)
		{
			if (!r.lname.empty()) {
				const auto pos = r.lname.find(tok);
				if (pos == 0)
					return 0;
				if (pos != std::string::npos) {
					const char before = r.lname[pos - 1];
					if (before == ' ' || before == '(' || before == '\'' || before == '-' || before == ':')
						return 1;
					return 2;
				}
			}
			if (!r.ledid.empty()) {
				const auto pos = r.ledid.find(tok);
				if (pos == 0)
					return 3;
				if (pos != std::string::npos)
					return 4;
			}
			if (r.lwords.find(tok) != std::string::npos)
				return 5;
			if (pl.lower.find(tok) != std::string::npos)
				return 6;
			return -1;
		}

		// ------------------------------------------------------------ resolve --
		RE::TESForm* ResolveForm(const std::string& id, const Row** rowOut)
		{
			if (rowOut)
				*rowOut = nullptr;
			const auto bar = id.find('|');
			if (bar == std::string::npos || bar == 0)
				return nullptr;
			const std::string   plugin = id.substr(0, bar);
			const std::uint32_t local = static_cast<std::uint32_t>(
				std::strtoul(id.c_str() + bar + 1, nullptr, 16));
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh || !local)
				return nullptr;
			if (rowOut) {
				const std::string plow = Lower(plugin);
				for (const auto& r : g_rows) {
					if (r.localId == local && g_plugins[r.plug].lower == plow) {
						*rowOut = &r;
						break;
					}
				}
			}
			return dh->LookupForm(local, plugin);
		}

		bool KnownBy(RE::Actor* who, RE::TESForm* form)
		{
			if (!who || !form)
				return false;
			if (auto* s = form->As<RE::SpellItem>())
				return who->HasSpell(s);
			if (auto* sh = form->As<RE::TESShout>())
				return who->HasShout(sh);
			return false;
		}

		bool KnownByPlayer(RE::TESForm* form)
		{
			return KnownBy(RE::PlayerCharacter::GetSingleton(), form);
		}

		// The crosshair actor snapshotted at palette open — never the player.
		RE::Actor* TargetActor()
		{
			const auto id = NpcActions::TargetFormID();
			if (!id)
				return nullptr;
			auto* a = RE::TESForm::LookupByID<RE::Actor>(id);
			if (!a || a == RE::PlayerCharacter::GetSingleton())
				return nullptr;
			return a;
		}

		std::string HexOf(RE::FormID id)
		{
			char fid[16];
			std::snprintf(fid, sizeof(fid), "%08X", id);
			return std::string("0x") + fid;
		}

		json EffectsJson(RE::MagicItem* mi)
		{
			json out = json::array();
			if (!mi)
				return out;
			for (auto* e : mi->effects) {
				if (!e || !e->baseEffect)
					continue;
				const char* n = e->baseEffect->GetFullName();
				out.push_back(json{
					{ "n", (n && *n) ? n : "" },
					{ "mag", e->effectItem.magnitude },
					{ "dur", e->effectItem.duration },
					{ "area", e->effectItem.area },
					{ "hostile", e->baseEffect->IsHostile() },
				});
			}
			return out;
		}

		// Learn/teach for both form kinds. A shout is granted with its words
		// unlocked, or it would sit in the list unusable — this is the deck's
		// cheat verb, and it says so on the button.
		bool Grant(RE::Actor* who, RE::TESForm* form)
		{
			if (!who || !form)
				return false;
			if (auto* s = form->As<RE::SpellItem>()) {
				who->AddSpell(s);
				return who->HasSpell(s);
			}
			if (auto* sh = form->As<RE::TESShout>()) {
				who->AddShout(sh);
				for (auto& v : sh->variations)
					if (v.word)
						who->UnlockWord(v.word);
				return who->HasShout(sh);
			}
			return false;
		}

		// ------------------------------------------------------------- detail --
		json DetailFor(RE::TESForm* form, const Row* row)
		{
			json d = json::object();
			if (!form || !row)
				return d;
			const Plugin& pl = g_plugins[row->plug];
			d["name"] = row->name;
			d["kind"] = KindName(row->kind);
			d["known"] = KnownByPlayer(form);
			if (auto* t = TargetActor()) {
				const char* tn = t->GetName();
				d["target"] = json{ { "name", (tn && *tn) ? tn : "someone" }, { "known", KnownBy(t, form) },
					{ "formId", HexOf(t->GetFormID()) } };
			} else {
				d["target"] = nullptr;
			}
			d["edid"] = row->edid;
			d["formId"] = HexOf(form->GetFormID());
			d["plugin"] = pl.name;
			d["school"] = row->school;
			d["tier"] = row->tier;
			d["delivery"] = row->delivery;
			d["casting"] = row->casting;
			d["hostile"] = row->hostile;
			if (auto* s = form->As<RE::SpellItem>()) {
				d["cost"] = nullptr;
				d["chargeTime"] = s->GetChargeTime();
				d["effects"] = EffectsJson(s);
				// The vanilla item card's text, composed by the Spell Deck's own
				// describer — one describer, one wording.
				const auto desc = json::parse(SpellActions::DescriptionJson(pl.name, row->localId, row->formId),
					nullptr, false);
				d["desc"] = (!desc.is_discarded() && desc.is_object()) ? desc.value("text", std::string("")) : "";
				// DescriptionStats uses the same guarded reader as the index. Reuse
				// its result instead of evaluating perk conditions a second time.
				if (row->kind == Kind::Ability)
					d["cost"] = 0;
				else if (desc.is_object() && desc.contains("stats") && desc["stats"].is_object()) {
					const auto cost = desc["stats"].value("cost", json(nullptr));
					if (cost.is_number())
						d["cost"] = std::round(cost.get<double>());
				}
			} else if (auto* sh = form->As<RE::TESShout>()) {
				json words = json::array();
				for (auto& v : sh->variations) {
					if (!v.word)
						continue;
					const char* wn = v.word->GetFullName();
					const char* tr = v.word->translation.c_str();
					words.push_back(json{
						{ "word", (wn && *wn) ? wn : "" },
						{ "translation", (tr && *tr) ? tr : "" },
						{ "spell", v.spell ? FullNameOf(v.spell) : "" },
						{ "recovery", v.recoveryTime },
					});
				}
				d["words"] = std::move(words);
				d["effects"] = sh->variations[0].spell ? EffectsJson(sh->variations[0].spell) : json::array();
				d["desc"] = "";
				d["cost"] = 0;
			}
			return d;
		}

		json TargetJson()
		{
			if (auto* t = TargetActor()) {
				const char* tn = t->GetName();
				return json{ { "name", (tn && *tn) ? tn : "someone" }, { "formId", HexOf(t->GetFormID()) } };
			}
			return nullptr;
		}
	}

	std::string StateJson()
	{
		EnsureIndex();
		json plugs = json::array();
		for (const auto& p : g_plugins) {
			if (!p.count)
				continue;
			plugs.push_back(json{ { "n", p.name }, { "c", p.count }, { "k", p.ext }, { "l", p.light } });
		}
		return Dump(json{
			{ "phase", "ready" },
			{ "count", g_rows.size() },
			{ "pageSize", g_pageSize },
			{ "plugins", std::move(plugs) },
			{ "target", TargetJson() },
		});
	}

	std::string QueryJson(const std::string& req)
	{
		EnsureIndex();
		json in = json::object();
		try {
			in = json::parse(req);
		} catch (...) {}

		if (in.contains("detail")) {
			const int         seq = in.value("seq", 0);
			const std::string id = in.value("detail", std::string(""));
			const Row*        row = nullptr;
			auto*             form = ResolveForm(id, &row);
			if (!form || !row) {
				logger::info("spell-finder-detail: unresolved '{}'", id);
				return Dump(json{ { "seq", seq }, { "detail", id }, { "info", json::object() },
					{ "err", "That spell is not in the load order any more" } });
			}
			return Dump(json{ { "seq", seq }, { "detail", id }, { "info", DetailFor(form, row) } });
		}

		const std::string q = in.value("q", std::string(""));
		const std::string type = in.value("type", std::string("all"));
		const std::string plugin = in.value("plugin", std::string(""));
		const int         seq = in.value("seq", 0);
		const int         offset = (std::max)(0, in.value("offset", 0));
		const int         limit = std::clamp(in.value("limit", 60), 1, 100);

		const auto tokens = Tokens(q);
		const auto plugLower = Lower(plugin);
		auto*      player = RE::PlayerCharacter::GetSingleton();
		const bool wantKnown = type == "known";
		const bool wantUnknown = type == "unknown";

		struct Hit { int score; std::uint32_t idx; };
		std::vector<Hit> hits;
		hits.reserve(1024);

		for (std::uint32_t i = 0; i < g_rows.size(); ++i) {
			const Row& r = g_rows[i];
			if (type == "spell" && r.kind != Kind::Spell)
				continue;
			if (type == "power" && !(r.kind == Kind::Power || r.kind == Kind::Lesser || r.kind == Kind::Voice))
				continue;
			if (type == "shout" && r.kind != Kind::Shout)
				continue;
			if (type == "ability" && r.kind != Kind::Ability)
				continue;
			const Plugin& pl = g_plugins[r.plug];
			if (!plugLower.empty() && pl.lower != plugLower)
				continue;
			int  score = 0;
			bool okAll = true;
			for (const auto& tok : tokens) {
				const int s = TokenScore(r, pl, tok);
				if (s < 0) { okAll = false; break; }
				score += s;
			}
			if (!okAll)
				continue;
			if (wantKnown || wantUnknown) {
				// live, per hit — a Learn a second ago must already show
				auto*      form = RE::TESForm::LookupByID(r.formId);
				const bool kn = player && KnownBy(player, form);
				if (wantKnown != kn)
					continue;
			}
			hits.push_back(Hit{ score, i });
		}

		const bool browse = tokens.empty();
		std::sort(hits.begin(), hits.end(), [browse](const Hit& a, const Hit& b) {
			const Row& x = g_rows[a.idx];
			const Row& y = g_rows[b.idx];
			if (!browse && a.score != b.score)
				return a.score < b.score;
			// Castables before abilities at equal score: an ability row is the
			// plumbing (racial passives, perk effects), the spell is the thing.
			const bool xa = x.kind == Kind::Ability, ya = y.kind == Kind::Ability;
			if (xa != ya)
				return !xa;
			if (!browse && x.lname.size() != y.lname.size())
				return x.lname.size() < y.lname.size();   // "Flames" over "Flames of Oblivion"
			return x.lname < y.lname;
		});

		json      items = json::array();
		const int total = static_cast<int>(hits.size());
		for (int i = offset; i < total && i < offset + limit; ++i) {
			const Row&    r = g_rows[hits[static_cast<std::size_t>(i)].idx];
			const Plugin& pl = g_plugins[r.plug];
			char idbuf[16];
			std::snprintf(idbuf, sizeof(idbuf), "%06X", r.localId);
			auto* form = RE::TESForm::LookupByID(r.formId);
			items.push_back(json{
				{ "id", pl.name + "|" + idbuf },
				{ "n", r.name },
				{ "e", r.edid },
				{ "k", KindName(r.kind) },
				{ "s", r.school },
				{ "el", r.element },
				{ "ar", r.archetype },
				{ "t", r.tier },
				{ "d", r.delivery },
				{ "c", r.casting },
				{ "cost", r.cost ? json(*r.cost) : json(nullptr) },
				{ "hs", r.hostile },
				{ "kn", player && KnownBy(player, form) },
				{ "p", pl.name },
			});
		}
		return Dump(json{
			{ "seq", seq }, { "total", total }, { "offset", offset }, { "items", std::move(items) } });
	}

	std::string ActJson(const std::string& req)
	{
		EnsureIndex();
		json in = json::object();
		try {
			in = json::parse(req);
		} catch (...) {}
		const std::string act = in.value("act", std::string(""));
		const std::string id = in.value("id", std::string(""));

		auto fail = [&act](const std::string& msg) {
			return Dump(json{ { "ok", false }, { "act", act }, { "msg", msg } });
		};
		auto done = [&act](const std::string& msg) {
			return Dump(json{ { "ok", true }, { "act", act }, { "msg", msg } });
		};

		const Row* row = nullptr;
		auto*      form = ResolveForm(id, &row);
		if (!form || !row)
			return fail("That spell is not in the load order any more");
		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player)
			return fail("No game loaded");
		const std::string& name = row->name;
		const Plugin&      pl = g_plugins[row->plug];

		if (act == "learn") {
			if (KnownByPlayer(form))
				return done("You already know " + name);
			if (!Grant(player, form))
				return fail("The game refused to add " + name);
			logger::info("spell-finder: learn '{}' ({})", name, id);  // marker: spell-finder-learn
			return done("\xE2\x9C\xA6 Learned " + name);   // ✦
		}
		if (act == "forget") {
			if (row->kind == Kind::Shout)
				return fail("A shout cannot be unlearned \xE2\x80\x94 the game keeps its words");
			if (!KnownByPlayer(form))
				return done("You do not know " + name);
			// The Spell Deck's own remover: handles powers, refuses the race/perk/
			// quest-granted ones honestly, and its toast is the one the deck shows.
			const auto res = json::parse(SpellActions::RemoveFromSpellbook(pl.name, row->localId, row->formId, false),
				nullptr, false);
			const bool ok = !res.is_discarded() && res.value("ok", false);
			const std::string msg = (!res.is_discarded() && res.is_object()) ? res.value("msg", std::string("")) : "";
			logger::info("spell-finder: forget '{}' ({}) -> {}", name, id, ok);
			return ok ? done(msg.empty() ? ("Forgot " + name) : msg) : fail(msg.empty() ? ("Could not forget " + name) : msg);
		}
		if (act == "teach") {
			auto* t = TargetActor();
			if (!t)
				return fail("Look at someone when you open the deck \xE2\x80\x94 Teach gives the spell to the person in your crosshair");
			const char* tn = t->GetName();
			const std::string who = (tn && *tn) ? tn : "They";
			if (KnownBy(t, form))
				return done(who + " already knows " + name);
			if (!Grant(t, form))
				return fail("The game refused to teach " + who + " " + name);
			logger::info("spell-finder: teach '{}' to {:08X} ({})", name, t->GetFormID(), id);
			return done("\xE2\x9C\xA6 " + who + " now knows " + name);
		}
		if (act == "cast") {
			if (row->kind == Kind::Ability)
				return fail(name + " is an ability \xE2\x80\x94 it is passive, so Learn it instead of casting it");
			const bool known = KnownByPlayer(form);
			if (!known && row->kind != Kind::Spell)
				return fail("Learn " + name + " first \xE2\x80\x94 a power or shout fires through your voice slot, which only holds what you know");
			// Resolved only: main.cpp closes the palette and calls SpellActions::Cast.
			return Dump(json{ { "ok", true }, { "act", act },
				{ "msg", (known ? "Casting " : "Casting (unlearned) ") + name },
				{ "cast", json{ { "plugin", pl.name }, { "localId", row->localId }, { "formId", row->formId } } } });
		}
		return fail("Unknown action");
	}

	std::string SaveJson(const std::string& req)
	{
		LoadSettings();
		json in = json::object();
		try {
			in = json::parse(req);
		} catch (...) {}
		if (in.contains("pageSize"))
			g_pageSize = ClampPageSize(in.value("pageSize", g_pageSize));
		SaveSettingsFile();
		return Dump(json{ { "ok", true }, { "pageSize", g_pageSize } });
	}
}
