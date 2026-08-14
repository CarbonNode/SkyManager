// NPCs tab — the fast NPC finder. See npc_finder.h for the contract.
//
// Design notes that are load-bearing:
//  - Identity is (plugin, file-width-masked local FormID), the ESL-safe pair
//    the Items tab proved; never CommonLib's GetLocalFormID() (missing null
//    check — the 2026-08-03 CTD).
//  - The FACE identity can differ from the row identity: an NPC whose traits
//    come from a template wears the TEMPLATE's face, and the CK exported that
//    facegen file under the template's origin plugin + formid. FaceOwner()
//    walks the kTraits template chain, then the faceNPC chain, and the row
//    carries that owner's identity for the render. A chain that dead-ends in
//    a dynamic or leveled form means no face file exists — honest "" and the
//    view keeps its glyph (Rober signed off on that: "obviously for templates
//    this wouldnt work well").
//  - goto/bring find a LIVE reference by scanning ProcessLists' four handle
//    arrays (the Room Guard / Loot Highlighter precedent for ref walking) —
//    high first so a loaded-and-visible copy beats a far-away simulated one,
//    living before dead. A leveled spawn's base is a dynamic TESNPC whose
//    template chain leads back to the indexed base, so the match walks
//    ancestors, not just pointer equality.
//  - All JSON dumps use error_handler_t::replace — NPC names come out of
//    4,700 third-party plugins and are not guaranteed UTF-8.

#include "npc_finder.h"

#include "pch.h"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <optional>
#include <string>
#include <unordered_map>
#include <vector>

#include "item_icons.h"

namespace NpcFinder
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

		struct Npc
		{
			std::uint32_t formId;      // runtime — session-scoped lookups
			std::uint32_t localId;     // durable half of the row identity
			std::uint32_t faceLocal;   // face owner's local id (8-hex in the file name)
			std::uint16_t plug;        // index into g_plugins
			std::int16_t  facePlug;    // ditto, for the face owner; -1 = no face file
			std::uint16_t race;        // index into g_races
			bool          female;
			bool          unique;
			bool          essential;
			bool          templated;   // traits come from a template
			std::string   name;
			std::string   lower;
		};

		std::vector<Plugin>      g_plugins;
		std::vector<std::string> g_races;
		std::vector<Npc>         g_npcs;
		bool                     g_built = false;

		/* ── settings sidecar (Rober, 2026-08-14: "the finder page should
		 * probably be paginated … maybe default to 10?") ─────────────────────
		 * Only the persisted Finder page size lives here so far. Its own sidecar,
		 * NOT a hotkeys.json slice — the ItemExplorer / keys-cache precedent, so no
		 * shared save path is touched. Faces are the expensive 1024px renders, so
		 * this pane defaults to 10 (Rober's number); item-explorer defaults to 25. */
		int  g_pageSize = 10;
		bool g_settingsLoaded = false;

		int ClampPageSize(int n)
		{
			return std::clamp(n, 1, 100);
		}

		std::filesystem::path SettingsPath()
		{
			return std::filesystem::path("Data") / "SKSE" / "Plugins" / "HotkeyDeck" / "npc-finder.json";
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
					// unknown keys survive: j is READ-only here, the writer emits
					// back only the fields we own.
					g_pageSize = ClampPageSize(j.value("pageSize", g_pageSize));
			} catch (...) {
				logger::warn("npc-finder: settings sidecar unreadable - defaults kept");
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
					logger::warn("npc-finder: could not write {}", tmp.string());
					return;
				}
				out << Dump(json{ { "pageSize", g_pageSize } });
			}
			std::filesystem::rename(tmp, path, ec);
			if (ec)
				logger::warn("npc-finder: settings rename failed: {}", ec.message());
		}

		std::uint16_t PlugIndexFor(RE::TESFile* file,
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

		std::uint16_t RaceIndexFor(const std::string& name,
			std::unordered_map<std::string, std::uint16_t>& map)
		{
			if (auto it = map.find(name); it != map.end())
				return it->second;
			const auto idx = static_cast<std::uint16_t>(g_races.size());
			g_races.push_back(name);
			map.emplace(name, idx);
			return idx;
		}

		/* ── creature BODY renders (Rober, 2026-08-14: "can these meshs be
		 * supported too?") ──────────────────────────────────────────────────
		 * A creature TESNPC has no facegen NIF — the humanoid FaceGen route is
		 * head-only. Its visible form IS its skin ARMO's armor-addon biped
		 * model for its race, exactly the Dragon Roost / Mounts route
		 * (Mounts::BodyNifOf). The render is keyed by the SKIN SOURCE (the race
		 * that supplies the body), so every Storm Atronach shares one render
		 * instead of baking a copy per instance — the deliberate v1 limitation
		 * that a creature whose skin has separate body/head ARMA parts renders
		 * only the body part (the largest / first with a model). */
		struct BodyLook
		{
			std::string   nif;       // the biped model path the framework renders
			std::string   idPlugin;  // skin-source identity: plugin + ...
			std::uint32_t idLocal{ 0 };  // ...file-width-masked local id (dedup key)
		};

		// The identity that keys a body render: the RACE (species), so same-race
		// creatures collapse to one file. Falls back to the NPC's own skin
		// override's identity when the race has none, and finally to the NPC
		// itself — always a durable, plugin-resolvable pair, never a dynamic id.
		void SetBodyIdentity(BodyLook& look, RE::TESForm* src)
		{
			if (!src)
				return;
			auto* file = src->GetFile(0);
			if (!file)
				return;   // dynamic form — not a durable key; leave the fallback
			look.idPlugin = std::string(file->GetFilename());
			look.idLocal = src->GetFormID() & (file->IsLight() ? 0xFFFu : 0xFFFFFFu);
		}

		BodyLook BodyLookFor(RE::TESNPC* npc)
		{
			BodyLook look;
			if (!npc)
				return look;
			auto* race = npc->race;
			if (!race)
				return look;
			const int sex =
				npc->actorData.actorBaseFlags.any(RE::ACTOR_BASE_DATA::Flag::kFemale) ? 1 : 0;
			const auto fromArmor = [&](RE::TESObjectARMO* armo) -> std::string {
				if (!armo)
					return {};
				if (auto* arma = armo->GetArmorAddon(race)) {
					if (const char* mdl = arma->bipedModels[sex].GetModel(); mdl && *mdl)
						return mdl;
					if (const char* mdl = arma->bipedModels[sex ? 0 : 1].GetModel(); mdl && *mdl)
						return mdl;   // many creatures fill only one sex slot
				}
				for (auto* ad : armo->armorAddons) {
					if (!ad)
						continue;
					for (const auto& bm : ad->bipedModels)
						if (const char* mdl = bm.GetModel(); mdl && *mdl)
							return mdl;
				}
				return {};
			};
			// Model: per-NPC skin override -> race skin (the species) -> far skin.
			// Identity: the RACE (so the render is shared per species); if the
			// body actually came from a per-NPC skin, key it by that instead so
			// a re-skinned unique does not collide with its vanilla race.
			if (auto s = fromArmor(npc->skin); !s.empty()) {
				look.nif = std::move(s);
				SetBodyIdentity(look, npc->skin);
				return look;
			}
			if (auto s = fromArmor(race->skin); !s.empty()) {
				look.nif = std::move(s);
				SetBodyIdentity(look, race);
				return look;
			}
			if (auto s = fromArmor(npc->farSkin); !s.empty()) {
				look.nif = std::move(s);
				SetBodyIdentity(look, race);
				return look;
			}
			return look;
		}

		/* The NPC whose facegen file names this face. Traits-template chain
		 * first (a templated NPC wears the template's exported head), then the
		 * faceNPC ("face template") chain the CK also supports. Bounded — a
		 * cyclic chain in a broken mod must not hang the index walk. */
		RE::TESNPC* FaceOwner(RE::TESNPC* npc)
		{
			RE::TESNPC* n = npc;
			for (int i = 0; i < 16 && n; ++i) {
				if (n->actorData.templateUseFlags.any(RE::ACTOR_BASE_DATA::TEMPLATE_USE_FLAG::kTraits)) {
					auto* t = n->baseTemplateForm;
					auto* tn = t ? t->As<RE::TESNPC>() : nullptr;
					if (tn && tn != n) {
						n = tn;
						continue;
					}
				}
				break;
			}
			for (int i = 0; i < 16 && n && n->faceNPC && n->faceNPC != n; ++i)
				n = n->faceNPC;
			return n ? n : npc;
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
			std::unordered_map<std::string, std::uint16_t>        rmap;
			g_npcs.reserve(32768);
			for (auto* npc : dh->GetFormArray<RE::TESNPC>()) {
				if (!npc)
					continue;
				const char* nm = npc->GetName();
				if (!nm || !*nm)
					continue;  // nameless = internal machinery, unfindable by a user
				auto* file = npc->GetFile(0);
				if (!file)
					continue;  // dynamic (0xFF…) — leveled-spawn bases, not durable
				if (npc->GetFormID() == 0x7)
					continue;  // the Player base
				if (npc->actorData.actorBaseFlags.any(RE::ACTOR_BASE_DATA::Flag::kIsChargenFacePreset))
					continue;  // chargen presets are named but are not people
				Npc n;
				n.formId = npc->GetFormID();
				n.localId = n.formId & (file->IsLight() ? 0xFFFu : 0xFFFFFFu);
				n.plug = PlugIndexFor(file, pmap);
				n.female = npc->actorData.actorBaseFlags.any(RE::ACTOR_BASE_DATA::Flag::kFemale);
				n.unique = npc->actorData.actorBaseFlags.any(RE::ACTOR_BASE_DATA::Flag::kUnique);
				n.essential = npc->actorData.actorBaseFlags.any(RE::ACTOR_BASE_DATA::Flag::kEssential);
				n.templated = npc->actorData.templateUseFlags.any(RE::ACTOR_BASE_DATA::TEMPLATE_USE_FLAG::kTraits) &&
				              npc->baseTemplateForm != nullptr;
				auto* race = npc->GetRace();
				const char* rn = race ? race->GetName() : nullptr;
				n.race = RaceIndexFor((rn && *rn) ? rn : "", rmap);
				// Face identity — may be another NPC in another plugin entirely.
				n.facePlug = -1;
				n.faceLocal = 0;
				if (auto* face = FaceOwner(npc)) {
					if (auto* ffile = face->GetFile(0)) {
						n.facePlug = static_cast<std::int16_t>(PlugIndexFor(ffile, pmap));
						n.faceLocal = face->GetFormID() & (ffile->IsLight() ? 0xFFFu : 0xFFFFFFu);
					}
				}
				n.name = nm;
				n.lower = Lower(n.name);
				g_plugins[n.plug].count++;
				g_npcs.push_back(std::move(n));
			}
			const auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
				std::chrono::steady_clock::now() - t0).count();
			logger::info("npc-finder: index built - {} npcs across {} plugins in {} ms",
				g_npcs.size(), g_plugins.size(), ms);
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

		// 0 best, -1 no match — the Items tab's ranking verbatim, plus the race
		// name as a soft field ("nord", "dunmer" narrow without a pill).
		int TokenScore(const Npc& n, const Plugin& pl, const std::string& tok)
		{
			const auto pos = n.lower.find(tok);
			if (pos == 0)
				return 0;
			if (pos != std::string::npos) {
				const char before = n.lower[pos - 1];
				if (before == ' ' || before == '(' || before == '\'' || before == '-')
					return 1;
				return 2;
			}
			if (Lower(g_races[n.race]).find(tok) != std::string::npos)
				return 3;
			if (pl.lower.find(tok) != std::string::npos)
				return 4;
			return -1;
		}

		// ------------------------------------------------------------ resolve --
		RE::TESNPC* ResolveId(const std::string& id, std::string* nameOut)
		{
			const auto bar = id.find('|');
			if (bar == std::string::npos || bar == 0)
				return nullptr;
			const std::string   plugin = id.substr(0, bar);
			const std::uint32_t local = static_cast<std::uint32_t>(
				std::strtoul(id.c_str() + bar + 1, nullptr, 16));
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh || !local)
				return nullptr;
			auto* form = dh->LookupForm(local, plugin);
			auto* npc = form ? form->As<RE::TESNPC>() : nullptr;
			if (npc && nameOut) {
				const char* nm = npc->GetName();
				*nameOut = (nm && *nm) ? nm : "that NPC";
			}
			return npc;
		}

		// A live actor's base is `target`, or descends from it: leveled spawns
		// carry a dynamic base whose template chain leads back to the record the
		// index (and the user) named. Bounded like FaceOwner.
		bool BaseDescendsFrom(RE::TESNPC* base, RE::TESNPC* target)
		{
			RE::TESNPC* n = base;
			for (int i = 0; i < 16 && n; ++i) {
				if (n == target)
					return true;
				auto* t = n->baseTemplateForm;
				n = t ? t->As<RE::TESNPC>() : nullptr;
			}
			return false;
		}

		struct FoundActor
		{
			RE::Actor* actor = nullptr;
			bool       dead = false;
		};

		/* Scan the four process arrays, most-loaded first. First LIVING match in
		 * the earliest array wins; a dead match is kept as the fallback so
		 * "go to" can still take you to a corpse (and say so). */
		FoundActor FindLoaded(RE::TESNPC* target)
		{
			FoundActor found;
			auto* pl = RE::ProcessLists::GetSingleton();
			if (!pl || !target)
				return found;
			const RE::BSTArray<RE::ActorHandle>* arrays[4] = {
				&pl->highActorHandles, &pl->middleHighActorHandles,
				&pl->middleLowActorHandles, &pl->lowActorHandles
			};
			for (const auto* arr : arrays) {
				for (const auto& h : *arr) {
					auto a = h.get();
					if (!a)
						continue;
					auto* base = a->GetActorBase();
					if (!base || !BaseDescendsFrom(base, target))
						continue;
					if (a->IsDead()) {
						if (!found.actor) {
							found.actor = a.get();
							found.dead = true;
						}
						continue;
					}
					found.actor = a.get();
					found.dead = false;
					return found;
				}
			}
			return found;
		}

		// The indexed record itself, re-looked-up by its durable identity — for
		// the per-page body resolve (which needs the live TESNPC, not just the
		// index row). ESL-safe LookupForm, exactly like ResolveId's.
		RE::TESNPC* ResolveById(const Npc& n)
		{
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh || n.plug >= g_plugins.size())
				return nullptr;
			auto* form = dh->LookupForm(n.localId, g_plugins[n.plug].name);
			return form ? form->As<RE::TESNPC>() : nullptr;
		}

		// Does the baked FaceGen head for this face identity actually exist on
		// disk (loose or BSA, MO2 VFS applied)? The face render CAN'T be made
		// without it — a creature has a face OWNER but no file, and so does a
		// humanoid whose author never exported one. `fc` is "Plugin.esp|8HEX".
		//
		// Cached per session: a face file's existence does not change while the
		// game runs, and QueryJson probes it for every drawn row on every
		// (settled) keystroke — a 60-row page paged/re-typed repeatedly would
		// otherwise hit the resource stack thousands of times on the main
		// thread. The cache makes the second probe of any identity free.
		bool FaceNifExists(const std::string& fc)
		{
			static std::unordered_map<std::string, bool> cache;
			if (auto it = cache.find(fc); it != cache.end())
				return it->second;
			const auto bar = fc.find('|');
			if (bar == std::string::npos || bar == 0)
				return false;
			const std::string plugin = fc.substr(0, bar);
			std::string       hex = fc.substr(bar + 1);
			for (auto& c : hex)
				c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
			if (hex.empty() || hex.size() > 8)
				return false;
			while (hex.size() < 8)
				hex.insert(hex.begin(), '0');
			const std::string rel =
				"meshes\\actors\\character\\facegendata\\facegeom\\" + plugin + "\\" + hex + ".nif";
			RE::BSResourceNiBinaryStream probe(rel.c_str());
			const bool ok = probe.good();
			cache.emplace(fc, ok);
			return ok;
		}
	}

	// ================================================================ API ==

	std::string StateJson()
	{
		EnsureIndex();
		json plugs = json::array();
		for (const auto& p : g_plugins) {
			if (!p.count)
				continue;  // face-only plugins (a template source with no named NPC of its own)
			plugs.push_back(json{ { "n", p.name }, { "c", p.count }, { "k", p.ext }, { "l", p.light } });
		}
		// Hand the view the WHOLE on-disk face/body index up front. A face
		// rendered in a PRIOR session (durable now — item_icons persists
		// npc-icons.json) resolves the moment a query's rows are drawn, so an
		// already-rendered face shows on the FIRST paint with no nxIcons round-
		// trip, no shimmer, no <img> re-decode — the "faces always reload" fix
		// (2026-08-14). NpcIconsJson is {"version":1,"icons":{...}}; the view
		// merges its `icons` into state.icons. An old view ignores the field.
		json icons = json::object();
		{
			auto j = json::parse(ItemIcons::NpcIconsJson(), nullptr, false);
			if (!j.is_discarded() && j.is_object() && j.contains("icons") && j["icons"].is_object())
				icons = std::move(j["icons"]);
		}
		return Dump(json{
			{ "phase", "ready" },
			{ "count", g_npcs.size() },
			{ "mrf", ItemIcons::Available() },
			{ "pageSize", g_pageSize },   // persisted Finder page size; an old view ignores it
			{ "plugins", std::move(plugs) },
			{ "icons", std::move(icons) },   // on-disk face/body renders, keyed "0X…|plugin"
		});
	}

	std::string QueryJson(const std::string& req)
	{
		EnsureIndex();
		json in = json::object();
		try {
			in = json::parse(req);
		} catch (...) {}
		const std::string q = in.value("q", std::string(""));
		const std::string type = in.value("type", std::string("all"));
		const std::string plugin = in.value("plugin", std::string(""));
		const int         seq = in.value("seq", 0);
		const int         offset = (std::max)(0, in.value("offset", 0));
		// The view's chosen page size arrives as `limit` (1..100 selector). A
		// request WITHOUT the field is an OLD view — default to 60, the
		// pre-pagination behaviour, so DLL and view can deploy independently.
		const int         limit = std::clamp(in.value("limit", 60), 1, 100);

		const auto tokens = Tokens(q);
		const auto plugLower = Lower(plugin);

		struct Hit { int score; std::uint32_t idx; };
		std::vector<Hit> hits;
		hits.reserve(1024);

		for (std::uint32_t i = 0; i < g_npcs.size(); ++i) {
			const Npc& n = g_npcs[i];
			if (type == "uniq" && !n.unique)
				continue;
			if (type == "fem" && !n.female)
				continue;
			if (type == "male" && n.female)
				continue;
			const Plugin& pl = g_plugins[n.plug];
			if (!plugLower.empty() && pl.lower != plugLower)
				continue;
			int  score = 0;
			bool okAll = true;
			for (const auto& tok : tokens) {
				const int s = TokenScore(n, pl, tok);
				if (s < 0) { okAll = false; break; }
				score += s;
			}
			if (!okAll)
				continue;
			hits.push_back(Hit{ score, i });
		}

		const bool browse = tokens.empty();
		std::sort(hits.begin(), hits.end(), [browse](const Hit& a, const Hit& b) {
			const Npc& x = g_npcs[a.idx];
			const Npc& y = g_npcs[b.idx];
			if (browse) {
				// A plugin's roster reads named-people-first, like a census would.
				if (x.unique != y.unique)
					return x.unique;
				return x.lower < y.lower;
			}
			if (a.score != b.score)
				return a.score < b.score;
			if (x.unique != y.unique)
				return x.unique;   // "lydia" should find THE Lydia above copies
			if (x.lower.size() != y.lower.size())
				return x.lower.size() < y.lower.size();
			return x.lower < y.lower;
		});

		json items = json::array();
		json bodyQueue = json::array();   // creature body renders for the drawn page
		const int total = static_cast<int>(hits.size());
		for (int i = offset; i < total && i < offset + limit; ++i) {
			const Npc&    n = g_npcs[hits[static_cast<std::size_t>(i)].idx];
			const Plugin& pl = g_plugins[n.plug];
			char idbuf[16];
			std::snprintf(idbuf, sizeof(idbuf), "%06X", n.localId);
			std::string fc;
			if (n.facePlug >= 0) {
				char fbuf[16];
				std::snprintf(fbuf, sizeof(fbuf), "%08X", n.faceLocal);
				fc = g_plugins[static_cast<std::size_t>(n.facePlug)].name + "|" + fbuf;
			}
			/* Creatures (Storm Atronach, Dwarven Spider, Draugr, Riekling…)
			 * have a face OWNER but no facegen NIF on disk — the humanoid head
			 * route can't picture them. Only for the DRAWN page (cheap, bounded
			 * by `limit`) do we probe the face file; when it is absent we blank
			 * `fc` so the view never asks for a head that can't render, resolve
			 * the creature's BODY (race-skin ARMA biped model, the Mounts
			 * route), and hand back a `bd` identity keyed by the SKIN SOURCE so
			 * same-race creatures share one render. A humanoid whose facegen
			 * simply never shipped falls into the same branch and at least gets
			 * a body silhouette instead of a bare glyph. */
			std::string bd;
			const bool faceOnDisk = fc.empty() ? false : FaceNifExists(fc);
			if (!faceOnDisk) {
				fc.clear();   // the head render would never land — don't poll for it
				if (auto* npc = ResolveById(n)) {
					const auto look = BodyLookFor(npc);
					if (!look.nif.empty() && !look.idPlugin.empty()) {
						char bbuf[16];
						std::snprintf(bbuf, sizeof(bbuf), "%06X", look.idLocal);
						bd = look.idPlugin + "|" + bbuf;
						char fidHex[16];
						std::snprintf(fidHex, sizeof(fidHex), "0x%x", look.idLocal);
						bodyQueue.push_back(json{
							{ "formId", std::string(fidHex) }, { "plugin", look.idPlugin },
							{ "name", n.name }, { "nif", look.nif } });
					}
				}
			}
			items.push_back(json{
				{ "id", pl.name + "|" + idbuf },
				{ "n", n.name },
				{ "p", pl.name },
				{ "r", g_races[n.race] },
				{ "s", n.female ? "f" : "m" },
				{ "u", n.unique },
				{ "e", n.essential },
				{ "t", n.templated },
				{ "fc", fc },
				{ "bd", bd },
			});
		}
		// Queue any creature bodies the drawn page needs (deduped in ItemIcons
		// by the skin-source key, so a page full of the same creature costs one
		// render). The view receives them through the shared nxIconsData index.
		if (!bodyQueue.empty()) {
			logger::info("npc-finder: creature body queued - {} on this page", bodyQueue.size());
			ItemIcons::EnsureBodyIcons(Dump(json{ { "items", std::move(bodyQueue) } }));
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
			return Dump(json{ { "ok", false }, { "act", act }, { "found", false }, { "msg", msg } });
		};

		std::string name;
		auto*       npc = ResolveId(id, &name);
		auto*       player = RE::PlayerCharacter::GetSingleton();
		if (!npc || !player)
			return fail("That NPC is not in the load order any more");

		if (act == "spawn") {
			auto ref = player->PlaceObjectAtMe(npc, false);
			if (!ref)
				return fail("The engine refused to place " + name);
			const std::string msg = "\xE2\x9C\xA6 " + name + " appears";  // ✦
			RE::DebugNotification(msg.c_str());
			logger::info("npc-finder: spawned '{}' ({})", name, id);
			return Dump(json{ { "ok", true }, { "act", act }, { "found", true }, { "msg", msg } });
		}

		if (act == "goto" || act == "bring") {
			const auto found = FindLoaded(npc);
			if (!found.actor)
				return fail(name + " isn't anywhere in the loaded world right now \xE2\x80\x94 Spawn a copy instead");
			// Physical move happens after ClosePalette() — main.cpp calls
			// ExecuteMove. This reply just says "close and go".
			return Dump(json{ { "ok", true }, { "act", act }, { "found", true },
				{ "msg", std::string(act == "goto" ? "Traveling to " : "Bringing ") + name +
						 (found.dead ? " (dead)" : "") } });
		}

		return fail("Unknown action");
	}

	std::string ExecuteMove(const std::string& req)
	{
		json in = json::object();
		try {
			in = json::parse(req);
		} catch (...) {}
		const std::string act = in.value("act", std::string(""));
		const std::string id = in.value("id", std::string(""));

		std::string name;
		auto*       npc = ResolveId(id, &name);
		auto*       player = RE::PlayerCharacter::GetSingleton();
		if (!npc || !player)
			return "NPC Finder: move failed";
		const auto found = FindLoaded(npc);
		if (!found.actor)
			return name + " slipped away \xE2\x80\x94 nothing was moved";
		if (act == "goto") {
			player->MoveTo(found.actor);
			logger::info("npc-finder: goto '{}'{}", name, found.dead ? " (dead)" : "");
			return "\xE2\xA4\x9E " + name + (found.dead ? " \xE2\x80\x94 what's left of them" : "");
		}
		found.actor->MoveTo(player);
		logger::info("npc-finder: bring '{}'{}", name, found.dead ? " (dead)" : "");
		return "\xE2\xA4\x9D " + name + " is here" + (found.dead ? " \xE2\x80\x94 the body, at least" : "");
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

	RE::TESNPC* FaceOwnerOf(RE::TESNPC* npc)
	{
		return FaceOwner(npc);
	}

	std::string BodyRenderFor(RE::TESNPC* npc, std::string& outNif)
	{
		outNif.clear();
		const auto look = BodyLookFor(npc);
		if (look.nif.empty() || look.idPlugin.empty())
			return {};
		outNif = look.nif;
		char bbuf[16];
		std::snprintf(bbuf, sizeof(bbuf), "%06X", look.idLocal);
		return look.idPlugin + "|" + bbuf;
	}

}
