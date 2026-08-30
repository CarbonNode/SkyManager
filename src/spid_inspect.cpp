// Distributions tab — SPID / SkyPatcher candidate-pool inspector.
// See spid_inspect.h for the contract and the honesty rules.
//
// Design notes that are load-bearing:
//  - The VFS is the source of truth: we enumerate Data/ exactly as the game
//    sees it, so only ENABLED mods' inis are ever read. No MO2 parsing.
//  - Parsing (worker thread) touches files and our own structs ONLY. Every
//    form lookup and every filter evaluation happens on the main thread,
//    which is where the bridge handlers already live.
//  - SPID semantics implemented: the documented comma=OR / '+'=AND / '-'=NOT
//    shape over string filters (name, base+template EditorID, keyword EDIDs),
//    form filters (race/class/combat style/faction/keyword/voice/plugin/
//    formlist/NPC-with-template-walk), actor-level + skill(min/max) level
//    filters, and the F/M/U/S/C/L traits. Anything beyond that is BADGED as
//    uncertain on the row instead of silently guessed — SPID grows syntax
//    faster than we should chase it.
//  - Identity compares are (plugin, file-width-masked local id) — the
//    ActorIdentity law. SkyPatcher inis routinely write full xEdit-style ids
//    ("Dawnguard.esm|02003373"), so tokens are masked before comparing.

#include "spid_inspect.h"

#include "pch.h"

#include <algorithm>
#include <atomic>
#include <cctype>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <functional>
#include <ctime>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

#include "actor_identity.h"
#include "icon_bridge.h"
#include "npc_actions.h"

namespace SpidInspect
{
	namespace
	{
		using json = nlohmann::json;

		std::string Dump(const json& j)
		{
			// NPC / item names come out of 4,700 third-party plugins and are not
			// guaranteed UTF-8 — the npc_finder law.
			return j.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		/* ⛔ NEVER call path::string() on anything under Data.
		 *
		 * On Windows a path is UTF-16 and string() converts it to the ANSI code
		 * page (cp1252 here), which THROWS std::system_error for any character
		 * that page cannot represent. Data's root is the union of ~4,800 mods,
		 * so it only takes one — and on 2026-08-19 it did: "Kingsglaive
		 * 仕様アニメイベント.txt", a Japanese-named readme from an MCO moveset,
		 * sitting beside the ini files. The SPID loop lowercased every filename
		 * BEFORE testing the suffix, so that .txt threw, the catch-all below
		 * swallowed it, and all 374 *_DISTR.ini files on the machine were lost
		 * to an empty index. The pane then said, quite honestly, that no mod
		 * ships a distribution file.
		 *
		 * u8string() cannot throw and is what the view wants anyway (the bridge
		 * speaks UTF-8), so it is also the right answer for display names —
		 * string() would have mangled them even when it got away with it. */
		std::string PathU8(const std::filesystem::path& p)
		{
			const auto u8 = p.u8string();
			return std::string(reinterpret_cast<const char*>(u8.data()), u8.size());
		}

		std::string Lower(std::string_view s)
		{
			std::string out(s);
			std::transform(out.begin(), out.end(), out.begin(),
				[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			return out;
		}

		std::string Trim(std::string_view s)
		{
			size_t b = 0, e = s.size();
			while (b < e && std::isspace(static_cast<unsigned char>(s[b])))
				++b;
			while (e > b && std::isspace(static_cast<unsigned char>(s[e - 1])))
				--e;
			return std::string(s.substr(b, e - b));
		}

		bool IEquals(std::string_view a, std::string_view b)
		{
			if (a.size() != b.size())
				return false;
			for (size_t i = 0; i < a.size(); ++i)
				if (std::tolower(static_cast<unsigned char>(a[i])) !=
					std::tolower(static_cast<unsigned char>(b[i])))
					return false;
			return true;
		}

		std::vector<std::string> Split(const std::string& s, char sep)
		{
			std::vector<std::string> out;
			size_t p = 0;
			while (p <= s.size()) {
				const auto n = s.find(sep, p);
				if (n == std::string::npos) {
					out.push_back(s.substr(p));
					break;
				}
				out.push_back(s.substr(p, n - p));
				p = n + 1;
			}
			return out;
		}

		// "NONE" (any case) and empty are the same absent section in SPID.
		bool IsNone(const std::string& s)
		{
			return s.empty() || IEquals(s, "NONE");
		}

		const char* NameOfForm(RE::TESForm* f)
		{
			if (!f)
				return "";
			if (const char* n = f->GetName(); n && *n)
				return n;
			return "";
		}

		// A label that is ALWAYS something a human can act on.
		//
		// Rober, 2026-08-19: "why do i see a lot of unnamed?" — leveled lists are
		// the answer. A LVLI/LVLN carries no FULL record, so GetName() is empty by
		// design, and GetFormEditorID() only answers when something (po3's Tweaks,
		// "Load EditorIDs") has kept the EditorID map alive. When both come up
		// empty the old code printed "(unnamed)", which names nothing, cannot be
		// searched for, and reads as a bug in the tab rather than a fact about the
		// record.
		//
		// The durable identity is always available, so the last rung is
		// "Plugin.esm 0X0F1A2C" — exactly what you would paste into xEdit or grep
		// the ini for. The kind word ("leveled list") is supplied by the caller,
		// because only it knows what the form is being shown AS.
		std::string ReadableName(RE::TESForm* f, const char* kindWord = nullptr)
		{
			if (!f)
				return kindWord ? std::string("(missing ") + kindWord + ")" : std::string("(missing form)");
			if (const char* n = f->GetName(); n && *n)
				return n;
			if (const char* ed = f->GetFormEditorID(); ed && *ed)
				return ed;
			std::string fid, plug;
			if (ActorIdentity::DurableOf(f, fid, plug) && !fid.empty()) {
				std::string out = plug.empty() ? fid : (plug + " " + fid);
				return kindWord ? (std::string(kindWord) + " " + out) : out;
			}
			return kindWord ? (std::string("(") + kindWord + ")") : std::string("(unnamed)");
		}

		// ------------------------------------------------------------ index --

		struct SpidEntry
		{
			std::string file;   // filename only, e.g. "Beggars Female - FDOSS_DISTR.ini"
			int         line = 0;
			std::string type;       // canonical: Outfit / Item / Spell / …
			std::string formSpec;   // section 0, raw
			std::string strF, formF, lvlF, traitF, countRaw, chanceRaw;
			double      chance = 100.0;
			// The line EXACTLY as the modder wrote it. Only the report uses this —
			// a line rebuilt from the parsed sections loses their spacing, their
			// casing and any trailing comment, which is precisely the detail you
			// are squinting at when a distribution will not fire.
			std::string raw;
		};

		struct SkyEntry
		{
			std::string file;
			int         line = 0;
			// key is lowered WITHOUT the "filterby" prefix ("npcs", "factions", …)
			std::vector<std::pair<std::string, std::string>> filters;
			std::vector<std::pair<std::string, std::string>> ops;  // key lowered, raw value
			std::string raw;   // the line as written — report only, see SpidEntry::raw
		};

		struct Index
		{
			std::vector<SpidEntry> spid;
			std::vector<SkyEntry>  sky;
			int                    spidFiles = 0;
			int                    skyFiles = 0;
			int                    skyOtherFiles = 0;  // SkyPatcher categories ≠ npc
			double                 parseMs = 0.0;
		};

		std::mutex        g_mx;           // guards g_index swap
		Index             g_index;
		std::atomic<int>  g_state{ 0 };   // 0 idle · 1 building · 2 ready
		std::atomic<int>  g_gen{ 0 };     // bumped when a build lands

		const char* const SPID_TYPES[] = {
			"Spell", "Perk", "Item", "Shout", "LevSpell", "Package", "Outfit",
			"Keyword", "DeathItem", "Faction", "SleepOutfit", "Skin"
		};

		void ParseSpidFile(const std::filesystem::path& p, Index& ix)
		{
			std::ifstream in(p, std::ios::binary);
			if (!in)
				return;
			++ix.spidFiles;
			const std::string fname = PathU8(p.filename());
			std::string       raw;
			int               lineNo = 0;
			bool              first = true;
			while (std::getline(in, raw)) {
				++lineNo;
				if (first) {  // strip a UTF-8 BOM
					first = false;
					if (raw.size() >= 3 && raw[0] == '\xEF' && raw[1] == '\xBB' && raw[2] == '\xBF')
						raw.erase(0, 3);
				}
				if (!raw.empty() && raw.back() == '\r')
					raw.pop_back();
				std::string line = Trim(raw);
				if (line.empty() || line[0] == ';' || line[0] == '#' || line[0] == '[')
					continue;
				const auto eq = line.find('=');
				if (eq == std::string::npos)
					continue;
				const std::string key = Trim(line.substr(0, eq));
				const char*       type = nullptr;
				for (const char* t : SPID_TYPES)
					if (IEquals(key, t)) {
						type = t;
						break;
					}
				if (!type)
					continue;
				SpidEntry e;
				e.file = fname;
				e.line = lineNo;
				e.type = type;
				e.raw = line;
				auto secs = Split(line.substr(eq + 1), '|');
				for (auto& s : secs)
					s = Trim(s);
				auto sec = [&](size_t i) -> std::string {
					if (i >= secs.size())
						return "";
					return IsNone(secs[i]) ? std::string("") : secs[i];
				};
				e.formSpec = sec(0);
				if (e.formSpec.empty())
					continue;
				e.strF = sec(1);
				e.formF = sec(2);
				e.lvlF = sec(3);
				e.traitF = sec(4);
				e.countRaw = sec(5);
				e.chanceRaw = sec(6);
				if (!e.chanceRaw.empty()) {
					try {
						e.chance = std::stod(e.chanceRaw);
					} catch (...) {
						e.chance = 100.0;
					}
				}
				ix.spid.push_back(std::move(e));
			}
		}

		void ParseSkyFile(const std::filesystem::path& p, Index& ix)
		{
			std::ifstream in(p, std::ios::binary);
			if (!in)
				return;
			++ix.skyFiles;
			const std::string fname = PathU8(p.filename());
			std::string       raw;
			int               lineNo = 0;
			bool              first = true;
			while (std::getline(in, raw)) {
				++lineNo;
				if (first) {
					first = false;
					if (raw.size() >= 3 && raw[0] == '\xEF' && raw[1] == '\xBB' && raw[2] == '\xBF')
						raw.erase(0, 3);
				}
				if (!raw.empty() && raw.back() == '\r')
					raw.pop_back();
				std::string line = Trim(raw);
				if (line.empty() || line[0] == ';' || line[0] == '#' || line[0] == '[')
					continue;
				if (Lower(line.substr(0, 8)) != "filterby")
					continue;
				SkyEntry e;
				e.file = fname;
				e.line = lineNo;
				e.raw = line;
				// The line is `:`-separated clauses of key=value. Values never
				// legitimately contain `:` in the wild (they are form lists), so a
				// flat split is right far more often than any cleverness.
				for (auto& clause : Split(line, ':')) {
					const std::string c = Trim(clause);
					if (c.empty())
						continue;
					const auto ceq = c.find('=');
					if (ceq == std::string::npos)
						continue;
					std::string k = Lower(Trim(c.substr(0, ceq)));
					std::string v = Trim(c.substr(ceq + 1));
					if (!v.empty() && v.back() == ',')  // trailing comma, seen in the wild
						v.pop_back();
					if (k.rfind("filterby", 0) == 0)
						e.filters.emplace_back(k.substr(8), std::move(v));
					else
						e.ops.emplace_back(std::move(k), std::move(v));
				}
				if (!e.ops.empty() && !e.filters.empty())
					ix.sky.push_back(std::move(e));
			}
		}

		void BuildIndexBlocking()
		{
			const auto t0 = std::chrono::steady_clock::now();
			Index      ix;
			std::error_code ec;

			// SPID reads Data root only, non-recursive — mirror that exactly.
			for (std::filesystem::directory_iterator it("Data", ec), end; !ec && it != end; it.increment(ec)) {
				if (!it->is_regular_file(ec))
					continue;
				const std::string fn = Lower(PathU8(it->path().filename()));
				if (fn.size() > 10 && fn.compare(fn.size() - 10, 10, "_distr.ini") == 0)
					ParseSpidFile(it->path(), ix);
			}

			// SkyPatcher: recursive under its root; only the npc category targets
			// actors — the rest is counted so the UI can say it was seen, not judged.
			//
			// ⛔ TWO MO2/USVFS TRAPS, both measured on 2026-08-19 when this reported
			// "0 SkyPatcher npc lines in 0 files" while SkyPatcher's OWN log showed it
			// loading 91 npc inis (394 total) from this very tree. The whole system was
			// invisible to the Distributions tab and the tab said nothing was wrong.
			//
			// 1. NO exists() GATE. This tree is PURELY VIRTUAL — nothing lives at
			//    <game>\Data\SKSE\Plugins\SkyPatcher on disk; every file is merged in
			//    from a mod folder. A probe of a directory that exists only in the VFS
			//    is not reliable, and gating the whole scan on it means one false
			//    answer silently deletes an entire distribution system from the report.
			//    An ec-guarded iterator over a directory that truly is not there simply
			//    yields nothing, so the gate bought us a failure mode and no safety.
			//
			// 2. lexically_relative, NEVER std::filesystem::relative. `relative()`
			//    canonicalises (weakly_canonical) and therefore TOUCHES THE FILESYSTEM,
			//    which on a virtual path can fail and hand back an empty path — and an
			//    empty relative path means the category comes out "", so every npc file
			//    is filed as "some other category" and the npc scan finds nothing while
			//    the walk itself looks perfectly healthy. lexically_relative is pure
			//    string arithmetic: it cannot fail, and it cannot lie about the VFS.
			const std::filesystem::path skyRoot = std::filesystem::path("Data") / "SKSE" / "Plugins" / "SkyPatcher";
			ec.clear();
			for (std::filesystem::recursive_directory_iterator it(skyRoot, ec), end; !ec && it != end; it.increment(ec)) {
				std::error_code fec;
				if (!it->is_regular_file(fec) || fec)
					continue;
				if (Lower(PathU8(it->path().extension())) != ".ini")
					continue;
				const auto rel = it->path().lexically_relative(skyRoot);
				std::string cat = (rel.begin() != rel.end()) ? Lower(PathU8(*rel.begin())) : std::string("");
				if (cat == "npc" || cat == "npcs")
					ParseSkyFile(it->path(), ix);
				else
					++ix.skyOtherFiles;
			}

			ix.parseMs = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
			{
				std::lock_guard l(g_mx);
				g_index = std::move(ix);
			}
			g_gen.fetch_add(1);
			g_state.store(2);
			std::lock_guard l(g_mx);
			// skyOtherFiles is logged too: it is the ONE number that separates "the
			// SkyPatcher tree was never seen" (0 here as well) from "seen, but every
			// file landed in the wrong category" — the two failure modes that produced
			// an identical, silent "0 npc files" before this was instrumented.
			logger::info("spid-inspect: index built ({} SPID lines / {} files, {} SkyPatcher npc lines / {} files, {} non-npc SkyPatcher file(s), {:.0f} ms)",
				g_index.spid.size(), g_index.spidFiles, g_index.sky.size(), g_index.skyFiles,
				g_index.skyOtherFiles, g_index.parseMs);
		}

		void KickBuild()
		{
			int expected = 0;
			if (g_state.compare_exchange_strong(expected, 1)) {
				std::thread([]() {
					try {
						BuildIndexBlocking();
					} catch (const std::exception& ex) {
						// An unreadable Data dir must not wedge the state machine —
						// but SAY WHAT HAPPENED. The bare "index build threw" this
						// used to print cost a whole diagnosis: the pane reported
						// "no distribution files" on a load order with 374 of them
						// and the log knew nothing more than the user did.
						g_state.store(2);
						logger::warn("spid-inspect: index build threw ({}) — empty index kept", ex.what());
					} catch (...) {
						g_state.store(2);
						logger::warn("spid-inspect: index build threw (non-std exception) — empty index kept");
					}
				}).detach();
			}
		}

		// ---------------------------------------------------------- context --

		struct Ctx
		{
			RE::Actor*  a = nullptr;
			RE::TESNPC* base = nullptr;

			std::string nameLo, edidLo;          // display name, base EDID
			std::vector<std::string> kwLo;       // keyword EDIDs (base + race)

			std::vector<RE::TESForm*> npcs;      // base + traits-template chain
			std::vector<RE::TESForm*> factions;
			std::vector<RE::TESForm*> keywords;  // as forms
			RE::TESForm*              race = nullptr;
			RE::TESForm*              cls = nullptr;
			RE::TESForm*              combatStyle = nullptr;
			RE::TESForm*              voice = nullptr;
			RE::TESForm*              outfit = nullptr;
			RE::TESForm*              sleepOutfit = nullptr;

			std::unordered_set<std::string> formEdidLo;  // EDIDs of everything above

			std::string basePluginLo;
			int         level = 0;
			bool        female = false, uniq = false, summonable = false;
			bool        child = false, leveled = false;
			RE::ActorValueOwner* avo = nullptr;
		};

		void AddEdid(Ctx& c, RE::TESForm* f)
		{
			if (!f)
				return;
			if (const char* e = f->GetFormEditorID(); e && *e)
				c.formEdidLo.insert(Lower(e));
		}

		void GatherKeywordsOf(Ctx& c, RE::BGSKeywordForm* kf)
		{
			if (!kf || !kf->keywords)
				return;
			for (std::uint32_t i = 0; i < kf->numKeywords; ++i) {
				auto* kw = kf->keywords[i];
				if (!kw)
					continue;
				c.keywords.push_back(kw);
				if (const char* e = kw->GetFormEditorID(); e && *e) {
					c.kwLo.push_back(Lower(e));
					c.formEdidLo.insert(Lower(e));
				}
			}
		}

		Ctx BuildCtx(RE::Actor* a)
		{
			Ctx c;
			c.a = a;
			c.base = a->GetActorBase();
			c.avo = a->AsActorValueOwner();
			c.level = static_cast<int>(a->GetLevel());
			if (const char* n = a->GetDisplayFullName(); n && *n)
				c.nameLo = Lower(n);
			auto* base = c.base;
			if (base) {
				if (c.nameLo.empty())
					if (const char* n = base->GetFullName(); n && *n)
						c.nameLo = Lower(n);
				if (const char* e = base->GetFormEditorID(); e && *e)
					c.edidLo = Lower(e);
				c.female = base->IsFemale();
				c.uniq = base->IsUnique();
				c.summonable = base->IsSummonable();
				c.cls = base->npcClass;
				c.combatStyle = base->combatStyle;
				c.voice = base->voiceType;
				c.outfit = base->defaultOutfit;
				c.sleepOutfit = base->sleepOutfit;
				std::string fid, plug;
				if (ActorIdentity::DurableOf(base, fid, plug))
					c.basePluginLo = Lower(plug);
				for (const auto& fr : base->factions)
					if (fr.faction) {
						c.factions.push_back(fr.faction);
						AddEdid(c, fr.faction);
					}
				GatherKeywordsOf(c, base);
				// Template chain (leveled spawns): SPID matches templates too, and
				// "L" is the leveled trait. Depth-capped — chains in the wild are
				// short and a malformed plugin must not loop us.
				c.npcs.push_back(base);
				auto* cur = base;
				for (int i = 0; i < 8 && cur; ++i) {
					auto* t = cur->baseTemplateForm ? cur->baseTemplateForm->As<RE::TESNPC>() : nullptr;
					if (!t)
						break;
					c.leveled = true;
					c.npcs.push_back(t);
					if (const char* e = t->GetFormEditorID(); e && *e)
						c.formEdidLo.insert(Lower(e));
					cur = t;
				}
			}
			if (auto* race = a->GetRace()) {
				c.race = race;
				AddEdid(c, race);
				GatherKeywordsOf(c, race);
			}
			c.child = a->IsChild();
			AddEdid(c, c.cls);
			AddEdid(c, c.combatStyle);
			AddEdid(c, c.voice);
			AddEdid(c, c.outfit);
			AddEdid(c, base);
			return c;
		}

		// --------------------------------------------------- form resolving --

		// Memoised per index generation: the same "0x13743" appears thousands of
		// times across the inis and the answer is immutable once data has loaded.
		std::unordered_map<std::string, RE::TESForm*> g_resolveMemo;
		int                                           g_memoGen = -1;

		RE::TESForm* ResolveSpec(const std::string& spec)
		{
			if (spec.empty())
				return nullptr;
			if (g_memoGen != g_gen.load()) {
				g_resolveMemo.clear();
				g_memoGen = g_gen.load();
			}
			if (auto it = g_resolveMemo.find(spec); it != g_resolveMemo.end())
				return it->second;
			RE::TESForm* f = nullptr;
			if (spec.size() > 2 && spec[0] == '0' && (spec[1] == 'x' || spec[1] == 'X')) {
				const auto tilde = spec.find('~');
				if (tilde != std::string::npos)
					f = ActorIdentity::Resolve(spec.substr(0, tilde), Trim(spec.substr(tilde + 1)));
				else if (const auto id = ActorIdentity::ParseHex(spec))
					f = RE::TESForm::LookupByID(id);
			} else {
				f = RE::TESForm::LookupByEditorID(spec);
			}
			g_resolveMemo.emplace(spec, f);
			return f;
		}

		// "Plugin.esp|HEX" / "Plugin.esp|HEX~2" / bare EditorID — the SkyPatcher
		// spelling. Count out-param is for inventory ops.
		RE::TESForm* ResolveSkyToken(const std::string& tokIn, int* outCount)
		{
			std::string tok = tokIn;
			if (outCount)
				*outCount = 1;
			const auto tilde = tok.find('~');
			if (tilde != std::string::npos) {
				if (outCount) {
					try {
						*outCount = std::stoi(tok.substr(tilde + 1));
					} catch (...) {}
				}
				tok = Trim(tok.substr(0, tilde));
			}
			const auto bar = tok.find('|');
			if (bar == std::string::npos)
				return ResolveSpec(tok);
			const std::string plug = Trim(tok.substr(0, bar));
			const std::string hex = Trim(tok.substr(bar + 1));
			std::uint32_t     raw = 0;
			try {
				raw = static_cast<std::uint32_t>(std::stoul(hex, nullptr, 16));
			} catch (...) {
				return nullptr;
			}
			// xEdit-style full ids carry the load-order byte — mask before the
			// TESDataHandler lookup adds the plugin's own prefix (the ActorIdentity
			// trap). Try the full-width local first, then the light width.
			if (auto* f = ActorIdentity::Resolve(raw & 0xFFFFFFu, plug))
				return f;
			return ActorIdentity::Resolve(raw & 0xFFFu, plug);
		}

		bool FormInList(const std::vector<RE::TESForm*>& v, const RE::TESForm* f)
		{
			return std::find(v.begin(), v.end(), f) != v.end();
		}

		// Does the resolved form describe this NPC? Dispatch by what the form IS.
		bool FormMatchesCtx(RE::TESForm* f, const Ctx& c, int depth = 0)
		{
			if (!f)
				return false;
			switch (f->GetFormType()) {
			case RE::FormType::Race:
				return c.race == f;
			case RE::FormType::Class:
				return c.cls == f;
			case RE::FormType::CombatStyle:
				return c.combatStyle == f;
			case RE::FormType::VoiceType:
				return c.voice == f;
			case RE::FormType::Faction:
				return FormInList(c.factions, f);
			case RE::FormType::Keyword:
				return FormInList(c.keywords, f);
			case RE::FormType::Outfit:
				return c.outfit == f || c.sleepOutfit == f;
			case RE::FormType::NPC:
				return FormInList(c.npcs, f);
			case RE::FormType::FormList:
				if (depth < 2)
					if (auto* list = f->As<RE::BGSListForm>())
						for (auto* el : list->forms)
							if (el && FormMatchesCtx(el, c, depth + 1))
								return true;
				return false;
			default:
				return false;
			}
		}

		// ------------------------------------------------- SPID evaluation --

		// One comma-alternative: possibly negated, possibly a '+' AND-chain.
		struct Alt
		{
			bool                     neg = false;
			std::vector<std::string> parts;  // trimmed, non-empty
		};

		std::vector<Alt> ParseAlts(const std::string& section)
		{
			std::vector<Alt> out;
			for (auto& tok : Split(section, ',')) {
				std::string t = Trim(tok);
				if (t.empty())
					continue;
				Alt a;
				if (t[0] == '-') {
					a.neg = true;
					t = Trim(t.substr(1));
				}
				for (auto& p : Split(t, '+')) {
					const std::string q = Trim(p);
					if (!q.empty())
						a.parts.push_back(q);
				}
				if (!a.parts.empty())
					out.push_back(std::move(a));
			}
			return out;
		}

		bool StrPartMatches(const std::string& part, const Ctx& c)
		{
			const bool wild = part.find('*') != std::string::npos;
			std::string p = Lower(part);
			if (wild)
				p.erase(std::remove(p.begin(), p.end(), '*'), p.end());
			auto hit = [&](const std::string& hay) {
				if (hay.empty() || p.empty())
					return false;
				return wild ? hay.find(p) != std::string::npos : hay == p;
			};
			if (hit(c.nameLo) || hit(c.edidLo))
				return true;
			for (const auto& k : c.kwLo)
				if (hit(k))
					return true;
			// The RACE and TEMPLATE EditorIDs (2026-08-19). They were gathered into
			// formEdidLo, which only the FORM section ever read — so a line written
			// `Item = X|DarkElfRace|NONE|...`, i.e. the race as a STRING filter, was
			// never matched and was dropped with no badge. That is precisely the
			// "my Dark Elf should be picking up race-targeted mods" case, and the
			// header of this file already claimed template EditorIDs were covered.
			// formEdidLo is already lowered, so it composes with `hit` unchanged.
			for (const auto& k : c.formEdidLo)
				if (hit(k))
					return true;
			return false;
		}

		bool FormPartMatches(const std::string& part, const Ctx& c, bool& uncertain)
		{
			// A plugin filename alternative means "the NPC's base is defined there".
			const std::string lo = Lower(part);
			if (lo.size() > 4) {
				const auto ext = lo.substr(lo.size() - 4);
				if (ext == ".esp" || ext == ".esm" || ext == ".esl")
					return c.basePluginLo == lo;
			}
			if (auto* f = ResolveSpec(part))
				return FormMatchesCtx(f, c);
			// Unresolved EditorID: fall back to comparing against the EDIDs of
			// everything the NPC carries — right whenever the string IS one of
			// those records' EDIDs, and honest (badged) when it stays unknown.
			if (!(part.size() > 2 && part[0] == '0' && (part[1] == 'x' || part[1] == 'X')))
				if (c.formEdidLo.count(lo))
					return true;
			uncertain = true;
			return false;
		}

		// Shared OR/AND/NOT gate over one section. `match` judges a single part.
		template <class F>
		bool SectionPasses(const std::vector<Alt>& alts, std::vector<std::string>& why,
			const char* what, F&& match)
		{
			if (alts.empty())
				return true;
			bool anyPositive = false, positiveHit = false;
			for (const auto& a : alts) {
				bool all = true;
				bool unc = false;
				for (const auto& p : a.parts)
					if (!match(p, unc)) {
						all = false;
						break;
					}
				if (a.neg) {
					if (all)
						return false;  // an exclusion matched — hard out
					if (unc)
						why.push_back(std::string(what) + " exclusion '" + a.parts[0] + "' not evaluated");
				} else {
					anyPositive = true;
					if (all)
						positiveHit = true;
					else if (unc)
						why.push_back(std::string(what) + " '" + a.parts[0] + "' unresolved");
				}
			}
			return !anyPositive || positiveHit;
		}

		bool LevelPasses(const std::string& section, const Ctx& c, std::vector<std::string>& why)
		{
			if (section.empty())
				return true;
			for (auto& tokIn : Split(section, ',')) {
				const std::string tok = Trim(tokIn);
				if (tok.empty())
					continue;
				// skillIdx(min[/max]) ?
				const auto par = tok.find('(');
				double      val = 0;
				std::string range = tok;
				bool        parsedTarget = true;
				if (par != std::string::npos && tok.back() == ')') {
					int idx = -1;
					try {
						idx = std::stoi(tok.substr(0, par));
					} catch (...) {}
					if (idx >= 0 && idx <= 17 && c.avo)
						val = c.avo->GetActorValue(static_cast<RE::ActorValue>(idx + 6));
					else
						parsedTarget = false;
					range = tok.substr(par + 1, tok.size() - par - 2);
				} else {
					val = c.level;
				}
				double mn = 0, mx = 1e9;
				bool   parsedRange = false;
				const auto slash = range.find('/');
				try {
					if (slash == std::string::npos) {
						mn = std::stod(range);
						parsedRange = true;
					} else {
						mn = std::stod(range.substr(0, slash));
						mx = std::stod(range.substr(slash + 1));
						parsedRange = true;
					}
				} catch (...) {}
				if (!parsedTarget || !parsedRange) {
					why.push_back("level filter '" + tok + "' not evaluated");
					continue;  // uncertain — pass, badged
				}
				if (val < mn || val > mx)
					return false;
			}
			return true;
		}

		bool TraitsPass(const std::string& section, const Ctx& c, std::vector<std::string>& why)
		{
			if (section.empty())
				return true;
			for (auto& tokIn : Split(section, '/')) {
				std::string tok = Trim(tokIn);
				if (tok.empty())
					continue;
				bool neg = false;
				if (tok[0] == '-') {
					neg = true;
					tok = Trim(tok.substr(1));
				}
				if (tok.size() != 1) {
					why.push_back("trait '" + tok + "' not evaluated");
					continue;
				}
				bool have;
				switch (std::toupper(static_cast<unsigned char>(tok[0]))) {
				case 'F': have = c.female; break;
				case 'M': have = !c.female; break;
				case 'U': have = c.uniq; break;
				case 'S': have = c.summonable; break;
				case 'C': have = c.child; break;
				case 'L': have = c.leveled; break;
				default:
					why.push_back("trait '" + tok + "' unknown");
					continue;
				}
				if (have == neg)
					return false;
			}
			return true;
		}

		// ------------------------------------------------------- row build --

		struct Row
		{
			json        j;
			std::string textLo;  // the search haystack
			std::string group;   // outfit / item / spell / perk / keyword / other
			char        src;     // 'p' SPID · 'k' SkyPatcher
			double      chance = 100.0;
			int         rank = 5;
		};

		std::pair<std::string, int> GroupOfSpidType(const std::string& t)
		{
			if (t == "Outfit" || t == "SleepOutfit")
				return { "outfit", 0 };
			if (t == "Item" || t == "DeathItem")
				return { "item", 1 };
			if (t == "Spell" || t == "Shout" || t == "LevSpell")
				return { "spell", 2 };
			if (t == "Perk")
				return { "perk", 3 };
			if (t == "Keyword")
				return { "keyword", 4 };
			return { "other", 5 };
		}

		constexpr int kMaxItemsPerRow = 14;

		// The armor pieces inside an outfit (this is the "show the items it could
		// add" half of the ask). Leveled entries flatten one level, capped.
		json OutfitItems(RE::TESForm* f, int& total)
		{
			json out = json::array();
			auto push = [&](RE::TESForm* it, int count) {
				++total;
				if (out.size() >= kMaxItemsPerRow)
					return;
				// never "(unnamed)": ReadableName falls through to the durable
				// plugin+FormID, which is always searchable in xEdit or the ini
				json row{ { "name", ReadableName(it) } };
				std::string fid, plug;
				if (ActorIdentity::DurableOf(it, fid, plug)) {
					row["formId"] = fid;
					row["plugin"] = plug;
				}
				if (count > 1)
					row["count"] = count;
				out.push_back(std::move(row));
			};
			auto* outfit = f ? f->As<RE::BGSOutfit>() : nullptr;
			if (!outfit)
				return out;
			for (auto* it : outfit->outfitItems) {
				if (!it)
					continue;
				if (auto* lvl = it->As<RE::TESLevItem>()) {
					for (const auto& e : lvl->entries)
						if (e.form)
							push(e.form, static_cast<int>(e.count));
				} else {
					push(it, 1);
				}
			}
			return out;
		}

		Row BuildSpidRow(const SpidEntry& e, std::vector<std::string> why)
		{
			Row r;
			r.src = 'p';
			r.chance = e.chance;
			auto [grp, rank] = GroupOfSpidType(e.type);
			r.group = grp;
			r.rank = rank;

			auto* f = ResolveSpec(e.formSpec);
			std::string label = NameOfForm(f);
			if (label.empty()) {
				if (f)
					if (const char* ed = f->GetFormEditorID(); ed && *ed)
						label = ed;
				if (label.empty())
					label = e.formSpec;
			}
			json j{
				{ "src", "spid" },
				{ "group", r.group },
				{ "type", e.type },
				{ "label", label },
				{ "file", e.file },
				{ "line", e.line },
				{ "chance", e.chance },
				{ "raw", e.raw },   // report only; the view ignores it
			};
			if (f) {
				std::string fid, plug;
				if (ActorIdentity::DurableOf(f, fid, plug)) {
					j["formId"] = fid;
					j["plugin"] = plug;
				}
			} else {
				j["unresolvedForm"] = true;
				why.push_back("distributed form '" + e.formSpec + "' not found in this load order");
			}
			if (!e.countRaw.empty())
				j["count"] = e.countRaw;
			int totalItems = 0;
			if (r.group == "outfit") {
				j["items"] = OutfitItems(f, totalItems);
				if (totalItems > kMaxItemsPerRow)
					j["itemsMore"] = totalItems - kMaxItemsPerRow;
			}
			json filters = json::array();
			auto pushF = [&](const char* k, const std::string& v) {
				if (!v.empty())
					filters.push_back(json{ { "k", k }, { "v", v } });
			};
			pushF("strings", e.strF);
			pushF("forms", e.formF);
			pushF("level", e.lvlF);
			pushF("traits", e.traitF);
			j["filters"] = std::move(filters);
			if (!why.empty())
				j["uncertain"] = why;

			r.textLo = Lower(label + " " + e.type + " " + e.file + " " + e.formSpec);
			if (j.contains("items"))
				for (const auto& it : j["items"])
					r.textLo += " " + Lower(it.value("name", std::string("")));
			r.j = std::move(j);
			return r;
		}

		// Friendly labels for the SkyPatcher ops players actually meet. Fallback
		// is the raw key — honest, and searchable either way.
		std::string SkyOpLabel(const std::string& k)
		{
			static const std::unordered_map<std::string, const char*> L = {
				{ "outfitdefault", "Default outfit" },
				{ "outfitsleep", "Sleep outfit" },
				{ "addinventory", "Adds item" },
				{ "addoncetoinventory", "Adds item (once)" },
				{ "removeinventory", "Removes item" },
				{ "spellstoadd", "Adds spells" },
				{ "spellstoremove", "Removes spells" },
				{ "perkstoadd", "Adds perks" },
				{ "perkstoremove", "Removes perks" },
				{ "keywordstoadd", "Adds keywords" },
				{ "keywordstoremove", "Removes keywords" },
				{ "factionstoadd", "Adds factions" },
				{ "voicetype", "Voice type" },
				{ "setconfidence", "Confidence" },
				{ "setaggression", "Aggression" },
				{ "setessential", "Essential" },
				{ "setprotected", "Protected" },
				{ "setlevel", "Level" },
				{ "setclass", "Class" },
				{ "setcombatstyle", "Combat style" },
				{ "setrace", "Race" },
			};
			if (auto it = L.find(k); it != L.end())
				return it->second;
			return k;
		}

		std::pair<std::string, int> GroupOfSkyOps(const SkyEntry& e)
		{
			auto has = [&](const char* frag) {
				for (const auto& [k, v] : e.ops)
					if (k.find(frag) != std::string::npos)
						return true;
				return false;
			};
			if (has("outfit"))
				return { "outfit", 0 };
			if (has("inventory"))
				return { "item", 1 };
			if (has("spell"))
				return { "spell", 2 };
			if (has("perk"))
				return { "perk", 3 };
			if (has("keyword"))
				return { "keyword", 4 };
			return { "other", 5 };
		}

		bool SkyTokenMatches(const std::string& tokIn, const std::vector<RE::TESForm*>& cat,
			const std::unordered_set<std::string>& edids)
		{
			const std::string tok = Trim(tokIn);
			if (tok.empty())
				return false;
			if (tok.find('|') != std::string::npos) {
				auto* f = ResolveSkyToken(tok, nullptr);
				return f && FormInList(cat, f);
			}
			if (edids.count(Lower(tok)))
				return true;
			if (auto* f = ResolveSpec(tok))
				return FormInList(cat, f);
			return false;
		}

		bool SkyFilterPasses(const std::string& key, const std::string& val, const Ctx& c,
			bool& evaluated, std::vector<std::string>& why)
		{
			evaluated = true;
			const bool excluded = key.size() > 8 && key.compare(key.size() - 8, 8, "excluded") == 0;
			const std::string cat = excluded ? key.substr(0, key.size() - 8) : key;

			auto edidsOf = [](const std::vector<RE::TESForm*>& v) {
				std::unordered_set<std::string> out;
				for (auto* f : v)
					if (f)
						if (const char* e = f->GetFormEditorID(); e && *e)
							out.insert(Lower(e));
				return out;
			};
			auto anyTok = [&](const std::vector<RE::TESForm*>& forms) {
				const auto ed = edidsOf(forms);
				for (const auto& t : Split(val, ','))
					if (SkyTokenMatches(t, forms, ed))
						return true;
				return false;
			};

			bool hit;
			if (cat == "npcs")
				hit = anyTok(c.npcs);
			else if (cat == "factions")
				hit = anyTok(c.factions);
			else if (cat == "races" || cat == "race")
				hit = anyTok({ c.race });
			else if (cat == "keywords")
				hit = anyTok(c.keywords);
			else if (cat == "voicetypes" || cat == "voicetype")
				hit = anyTok({ c.voice });
			else if (cat == "classes" || cat == "class")
				hit = anyTok({ c.cls });
			else if (cat == "combatstyles" || cat == "combatstyle")
				hit = anyTok({ c.combatStyle });
			else if (cat == "outfits" || cat == "defaultoutfits")
				hit = anyTok({ c.outfit });
			else if (cat == "gender" || cat == "sex") {
				const std::string v = Lower(Trim(val));
				hit = (v == "female" || v == "f") ? c.female : (v == "male" || v == "m") ? !c.female : false;
				if (v != "female" && v != "f" && v != "male" && v != "m") {
					evaluated = false;
					why.push_back("filterBy" + key + "='" + val + "' not evaluated");
					return true;
				}
			} else if (cat == "level") {
				// filterByLevel=min or min/max
				const auto slash = val.find('/');
				try {
					const double mn = std::stod(slash == std::string::npos ? val : val.substr(0, slash));
					const double mx = slash == std::string::npos ? 1e9 : std::stod(val.substr(slash + 1));
					hit = c.level >= mn && c.level <= mx;
				} catch (...) {
					evaluated = false;
					why.push_back("filterByLevel='" + val + "' not evaluated");
					return true;
				}
			} else {
				evaluated = false;
				why.push_back("filterBy" + key + " not evaluated");
				return true;  // does not veto; the badge says so
			}
			return excluded ? !hit : hit;
		}

		Row BuildSkyRow(const SkyEntry& e, std::vector<std::string> why)
		{
			Row r;
			r.src = 'k';
			auto [grp, rank] = GroupOfSkyOps(e);
			r.group = grp;
			r.rank = rank;

			json ops = json::array();
			std::string label;
			std::string hay;
			for (const auto& [k, v] : e.ops) {
				json op{ { "k", k }, { "label", SkyOpLabel(k) }, { "v", v } };
				json items = json::array();
				// Resolve the value's form tokens to names where they look like
				// forms; plain words (confidence levels, yes/no) ride through raw.
				if (v.find('|') != std::string::npos) {
					for (const auto& tokIn : Split(v, ',')) {
						int  count = 1;
						auto* f = ResolveSkyToken(Trim(tokIn), &count);
						if (!f)
							continue;
						std::string nm = NameOfForm(f);
						if (nm.empty())
							if (const char* ed = f->GetFormEditorID(); ed && *ed)
								nm = ed;
						if (nm.empty())
							continue;
						json row{ { "name", nm } };
						std::string fid, plug;
						if (ActorIdentity::DurableOf(f, fid, plug)) {
							row["formId"] = fid;
							row["plugin"] = plug;
						}
						if (count > 1)
							row["count"] = count;
						hay += " " + Lower(nm);
						if (items.size() < kMaxItemsPerRow)
							items.push_back(std::move(row));
					}
				}
				if (!items.empty())
					op["items"] = std::move(items);
				if (!label.empty())
					label += " · ";
				label += SkyOpLabel(k);
				hay += " " + k + " " + Lower(v);
				ops.push_back(std::move(op));
			}
			json j{
				{ "src", "sky" },
				{ "group", r.group },
				{ "type", "Patch" },
				{ "label", label.empty() ? std::string("Patch") : label },
				{ "file", e.file },
				{ "line", e.line },
				{ "raw", e.raw },   // report only; the view ignores it
				{ "ops", std::move(ops) },
			};
			json filters = json::array();
			for (const auto& [k, v] : e.filters)
				filters.push_back(json{ { "k", "filterBy" + k }, { "v", v } });
			j["filters"] = std::move(filters);
			if (!why.empty())
				j["uncertain"] = why;
			r.textLo = Lower(label + " " + e.file) + hay;
			r.j = std::move(j);
			return r;
		}

		// ------------------------------------------------------ eval cache --

		struct EvalCache
		{
			std::uint32_t    baseId = 0;
			int              gen = -1;
			std::vector<Row> rows;
			int              unevaluated = 0;  // SkyPatcher lines we could not judge at all
			// SPID lines REJECTED while at least one of their filters could not be
			// judged. Distinct from `unevaluated` on purpose: that one means "we
			// judged nothing and refused to guess", this one means "we said no, but
			// part of the reason was a token we could not resolve". Conflating them
			// would hide which way the uncertainty leans.
			int              undecided = 0;
			/* WHY each undecided line was dropped, for the desktop report. The
			   COUNTER tells you something is hidden; only this tells you what and
			   why, which is the whole point of a diagnostic dump. Bounded: a load
			   order with thousands of unresolvable tokens must not turn a report
			   into a monologue (the tail is summarised as a count instead). */
			struct Undecided
			{
				std::string file, raw;
				int         line = 0;
				std::vector<std::string> why;
			};
			std::vector<Undecided> undecidedRows;
		};
		constexpr size_t kMaxUndecidedRows = 400;
		EvalCache g_eval;

		void EvaluateFor(RE::Actor* a)
		{
			auto* base = a->GetActorBase();
			const std::uint32_t bid = base ? base->GetFormID() : a->GetFormID();
			if (g_eval.baseId == bid && g_eval.gen == g_gen.load())
				return;

			const auto t0 = std::chrono::steady_clock::now();
			g_eval = EvalCache{};
			g_eval.baseId = bid;
			g_eval.gen = g_gen.load();

			const Ctx c = BuildCtx(a);

			std::lock_guard l(g_mx);
			for (const auto& e : g_index.spid) {
				std::vector<std::string> why;
				const auto strAlts = ParseAlts(e.strF);
				const auto formAlts = ParseAlts(e.formF);
				bool ok = SectionPasses(strAlts, why, "string filter",
					[&](const std::string& p, bool&) { return StrPartMatches(p, c); });
				if (ok)
					ok = SectionPasses(formAlts, why, "form filter",
						[&](const std::string& p, bool& unc) { return FormPartMatches(p, c, unc); });
				if (ok)
					ok = LevelPasses(e.lvlF, c, why);
				if (ok)
					ok = TraitsPass(e.traitF, c, why);
				if (ok)
					g_eval.rows.push_back(BuildSpidRow(e, std::move(why)));
				else if (!why.empty())
					// ⛔ THE HONESTY HOLE, closed 2026-08-19. `why` is appended ONLY
					// when a filter could not be JUDGED (SectionPasses/LevelPasses
					// push there for an unresolvable token, never for an honest
					// mismatch). So a non-empty `why` on a REJECTED line means we
					// threw away a line we did not actually understand — and until
					// now that happened silently and uncounted, which is exactly
					// what this module's own header (spid_inspect.h) promises never
					// happens. The SkyPatcher loop below already had this
					// accounting; SPID did not. Counting it is what lets the tab
					// say "these are the matches AND here is what I could not
					// judge" instead of implying the list is the whole truth.
					//
					// ⚠ BRACED DELIBERATELY. The counter and the detail are one
					// decision; an unbraced `else if` would bind only the ++ and
					// let the push_back run for EVERY line, including the matched
					// ones (whose `why` is empty after the move above), which
					// fills the report with rows that were never in trouble.
				{
					++g_eval.undecided;
					if (g_eval.undecidedRows.size() < kMaxUndecidedRows)
						g_eval.undecidedRows.push_back({ e.file, e.raw, e.line, why });
				}
			}
			for (const auto& e : g_index.sky) {
				std::vector<std::string> why;
				bool ok = true;
				int  evaluable = 0;
				for (const auto& [k, v] : e.filters) {
					bool evaluated = false;
					if (!SkyFilterPasses(k, v, c, evaluated, why)) {
						ok = false;
						break;
					}
					if (evaluated)
						++evaluable;
				}
				if (ok && evaluable == 0) {
					// Nothing judged: listing it would claim a match we never made.
					++g_eval.unevaluated;
					continue;
				}
				if (ok)
					g_eval.rows.push_back(BuildSkyRow(e, std::move(why)));
			}
			std::stable_sort(g_eval.rows.begin(), g_eval.rows.end(),
				[](const Row& a2, const Row& b2) {
					if (a2.rank != b2.rank)
						return a2.rank < b2.rank;
					return a2.chance > b2.chance;
				});
			const auto ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - t0).count();
			logger::info("spid-inspect: evaluated {} SPID + {} SkyPatcher lines -> {} matches "
				"({} SPID line(s) rejected with an unjudgeable filter, {} SkyPatcher line(s) unjudged) ({:.0f} ms)",
				g_index.spid.size(), g_index.sky.size(), g_eval.rows.size(),
				g_eval.undecided, g_eval.unevaluated, ms);
		}

		// ----------------------------------------------------------- target --

		json Refuse(const char* why, const std::string& msg, int seq)
		{
			return json{ { "ok", false }, { "seq", seq }, { "why", why }, { "msg", msg } };
		}

		// The niInspect resolution discipline: explicit ref wins, else the
		// crosshair snapshot the palette-open took.
		RE::Actor* ResolveTarget(const json& in, json& refusal, int seq)
		{
			const std::string ref = in.value("ref", std::string(""));
			if (!ref.empty()) {
				const auto fid = ActorIdentity::ParseHex(ref);
				auto*      a = fid ? RE::TESForm::LookupByID<RE::Actor>(fid) : nullptr;
				if (!a)
					refusal = Refuse("gone", "That reference is not in the world any more.", seq);
				return a;
			}
			const auto fid = NpcActions::TargetFormID();
			if (!fid) {
				refusal = Refuse("nothing",
					"Nothing was in your crosshair when the deck opened. Look at someone, "
					"press the deck key again, and open Distributions.",
					seq);
				return nullptr;
			}
			auto* a = RE::TESForm::LookupByID<RE::Actor>(fid);
			if (!a) {
				refusal = Refuse("gone", "Whoever you were looking at is no longer loaded.", seq);
				return nullptr;
			}
			if (a->IsPlayerRef()) {
				refusal = Refuse("object",
					"That is you — SPID and SkyPatcher target NPCs, and the player has no base "
					"record they distribute to this way.",
					seq);
				return nullptr;
			}
			return a;
		}

		json TargetCard(RE::Actor* a)
		{
			json who;
			auto* base = a->GetActorBase();
			std::string nm;
			if (const char* n = a->GetDisplayFullName(); n && *n)
				nm = n;
			if (nm.empty() && base)
				if (const char* n = base->GetFullName(); n && *n)
					nm = n;
			who["name"] = nm.empty() ? "Someone" : nm;
			who["level"] = static_cast<int>(a->GetLevel());
			if (auto* race = a->GetRace())
				if (const char* n = race->GetFullName(); n && *n)
					who["race"] = n;
			if (base) {
				who["sex"] = base->IsFemale() ? "Female" : "Male";
				who["unique"] = base->IsUnique();
				std::string fid, plug;
				if (ActorIdentity::DurableOf(base, fid, plug)) {
					who["formId"] = fid;
					who["plugin"] = plug;
				}
				if (const char* e = base->GetFormEditorID(); e && *e)
					who["edid"] = e;
				if (base->defaultOutfit)
					if (const char* n = NameOfForm(base->defaultOutfit); *n)
						who["outfitNow"] = n;
			}
			return who;
		}

		json IndexStatus()
		{
			json ix;
			const int st = g_state.load();
			ix["state"] = st == 2 ? "ready" : (st == 1 ? "building" : "idle");
			if (st == 2) {
				std::lock_guard l(g_mx);
				ix["spidFiles"] = g_index.spidFiles;
				ix["spidLines"] = g_index.spid.size();
				ix["skyFiles"] = g_index.skyFiles;
				ix["skyLines"] = g_index.sky.size();
				ix["skyOtherFiles"] = g_index.skyOtherFiles;
				ix["ms"] = g_index.parseMs;
			}
			return ix;
		}
	}

	// ================================================================ API ==

	std::string StateJson(const std::string& reqJson)
	{
		json in = json::object();
		{
			const auto j = json::parse(reqJson, nullptr, false);
			if (!j.is_discarded() && j.is_object())
				in = j;
		}
		const int seq = in.value("seq", 0);
		KickBuild();

		json out{ { "ok", true }, { "seq", seq } };
		out["index"] = IndexStatus();

		if (!RE::PlayerCharacter::GetSingleton())
			return Dump(Refuse("nosave", "No save is loaded, so there is nobody to look at.", seq));

		json       refusal;
		RE::Actor* a = ResolveTarget(in, refusal, seq);
		if (!a) {
			out["refuse"] = std::move(refusal);
			return Dump(out);
		}
		try {
			out["target"] = TargetCard(a);
		} catch (...) {
			out["refuse"] = Refuse("gone", "Something about that character could not be read.", seq);
		}
		return Dump(out);
	}

	std::string QueryJson(const std::string& reqJson)
	{
		json in = json::object();
		{
			const auto j = json::parse(reqJson, nullptr, false);
			if (!j.is_discarded() && j.is_object())
				in = j;
		}
		const int         seq = in.value("seq", 0);
		const std::string q = Lower(in.value("q", std::string("")));
		const std::string group = in.value("group", std::string(""));
		const int         limit = std::clamp(in.value("limit", 300), 1, 1000);

		KickBuild();
		if (g_state.load() != 2)
			return Dump(json{ { "ok", true }, { "seq", seq }, { "building", true } });

		if (!RE::PlayerCharacter::GetSingleton())
			return Dump(Refuse("nosave", "No save is loaded, so there is nobody to look at.", seq));

		json       refusal;
		RE::Actor* a = ResolveTarget(in, refusal, seq);
		if (!a) {
			json out{ { "ok", true }, { "seq", seq } };
			out["refuse"] = std::move(refusal);
			return Dump(out);
		}

		try {
			EvaluateFor(a);
		} catch (...) {
			// A half-built record from a third-party plugin must not take the
			// palette with it — the npc-inspect law.
			g_eval = {};
			logger::warn("spid-inspect: evaluation threw while reading an actor — refused");
			return Dump(Refuse("gone", "Something about that character could not be read.", seq));
		}

		std::vector<std::string> terms;
		for (auto& t : Split(q, ' '))
			if (!Trim(t).empty())
				terms.push_back(Trim(t));

		json counts{ { "all", 0 }, { "outfit", 0 }, { "item", 0 }, { "spell", 0 },
			{ "perk", 0 }, { "keyword", 0 }, { "other", 0 }, { "spid", 0 }, { "sky", 0 } };
		json rows = json::array();
		int  total = 0;
		for (const auto& r : g_eval.rows) {
			bool textHit = true;
			for (const auto& t : terms)
				if (r.textLo.find(t) == std::string::npos) {
					textHit = false;
					break;
				}
			if (!textHit)
				continue;
			counts["all"] = counts["all"].get<int>() + 1;
			counts[r.group] = counts[r.group].get<int>() + 1;
			counts[r.src == 'p' ? "spid" : "sky"] = counts[r.src == 'p' ? "spid" : "sky"].get<int>() + 1;
			if (!group.empty() && group != "all" && r.group != group)
				continue;
			++total;
			if (rows.size() < static_cast<size_t>(limit))
				rows.push_back(r.j);
		}

		json out{
			{ "ok", true },
			{ "seq", seq },
			{ "total", total },
			{ "shown", rows.size() },
			{ "counts", std::move(counts) },
			{ "unevaluated", g_eval.unevaluated },
			{ "undecided", g_eval.undecided },
			{ "rows", std::move(rows) },
		};
		return Dump(out);
	}
	// ------------------------------------------------------- leveled lists --
	//
	// A leveled list has no name, so a distribution row that hands one out can
	// only ever show its form spec — which is what "0x10BF70~Skyrim.esm" was.
	// The useful answer is what the roll can PRODUCE, so this walks the list.
	//
	// Nesting is normal (a food list made of food lists), and the walk is
	// bounded three ways: depth, total nodes, and a set of lists already
	// expanded on the current path. That last one is what makes a
	// self-referencing list impossible rather than merely unlikely — a mod
	// author can and does write one, and this runs on the MAIN thread.
	std::string LeveledJson(const std::string& reqJson)
	{
		constexpr int kMaxDepth = 6;
		constexpr int kMaxNodes = 500;

		json in = json::object();
		try {
			in = json::parse(reqJson);
		} catch (...) {
		}

		const std::string fidS = in.value("formId", std::string(""));
		const std::string plug = in.value("plugin", std::string(""));

		auto* form = ActorIdentity::Resolve(fidS, plug);
		if (!form)
			return Dump(json{ { "ok", false },
				{ "why", "that form is not in this load order" } });

		int nodes = 0;

		// Returns the node object for `f`, expanding it when it is a leveled
		// list. `seen` is the CURRENT PATH, not everything visited: a list may
		// legitimately appear twice as siblings, only a cycle is a problem.
		std::function<json(RE::TESForm*, int, int, std::vector<RE::FormID>&)> walk =
			[&](RE::TESForm* f, int count, int depth, std::vector<RE::FormID>& seen) -> json {
			json n = json::object();
			if (!f)
				return n;
			// The kind word is decided AFTER we know what the form is, a few lines
			// down — but the name must be right for a leveled list too, so ask for
			// the durable-identity fallback with the list wording when this form is
			// one. (A LVLI has no FULL record at all; "(unnamed)" was never a fact
			// about the world, only about our lookup.)
			const bool isList = f->As<RE::TESLevItem>() || f->As<RE::TESLevCharacter>();
			n["name"] = ReadableName(f, isList ? "leveled list" : nullptr);
			if (count > 1)
				n["count"] = count;
			std::string dfid, dplug;
			if (ActorIdentity::DurableOf(f, dfid, dplug)) {
				n["formId"] = dfid;
				n["plugin"] = dplug;
			}

			RE::TESLeveledList* ll = nullptr;
			if (auto* li = f->As<RE::TESLevItem>()) {
				ll = li;
				n["kind"] = "lvli";
			} else if (auto* lc = f->As<RE::TESLevCharacter>()) {
				ll = lc;
				n["kind"] = "lvln";
			} else {
				n["kind"] = "leaf";
				n["type"] = std::string(RE::FormTypeToString(f->GetFormType()));
				return n;
			}

			// chanceNone is the list's own "roll nothing" percentage; useAll
			// means every entry is handed out instead of one being picked. Both
			// change whether a child is a maybe or a certainty, so the view gets
			// them rather than inventing a story about the odds.
			n["chanceNone"] = static_cast<int>(ll->chanceNone);
			n["useAll"] = (static_cast<std::uint8_t>(ll->llFlags) &
				static_cast<std::uint8_t>(RE::TESLeveledList::Flag::kUseAll)) != 0;
			n["entryCount"] = static_cast<int>(ll->entries.size());

			const RE::FormID self = f->GetFormID();
			if (std::find(seen.begin(), seen.end(), self) != seen.end()) {
				n["cycle"] = true;
				return n;
			}
			if (depth >= kMaxDepth || nodes >= kMaxNodes) {
				n["truncated"] = true;
				return n;
			}

			seen.push_back(self);
			json kids = json::array();
			for (const auto& e : ll->entries) {
				if (!e.form)
					continue;
				if (nodes >= kMaxNodes) {
					n["truncated"] = true;
					break;
				}
				++nodes;
				json kid = walk(e.form, static_cast<int>(e.count), depth + 1, seen);
				if (e.level > 1)
					kid["level"] = static_cast<int>(e.level);
				kids.push_back(std::move(kid));
			}
			seen.pop_back();
			n["entries"] = std::move(kids);
			return n;
		};

		std::vector<RE::FormID> seen;
		json root = walk(form, 1, 0, seen);
		if (root.value("kind", std::string("leaf")) == "leaf")
			return Dump(json{ { "ok", false },
				{ "why", "that form is not a leveled list" },
				{ "node", std::move(root) } });

		logger::info("spid-inspect: expanded leveled list '{}' -> {} node(s)",
			root.value("name", std::string("?")), nodes);
		return Dump(json{ { "ok", true }, { "nodes", nodes }, { "root", std::move(root) } });
	}

	// ------------------------------------------------------- open on the PC --

	std::string OpenFileJson(const std::string& reqJson)
	{
		json in = json::object();
		try {
			in = json::parse(reqJson);
		} catch (...) {
		}
		const std::string want = in.value("file", std::string(""));
		if (want.empty())
			return Dump(json{ { "ok", false }, { "why", "no file was named" } });

		// Refuse anything that is not a bare filename. The view only ever sends
		// the `file` field the rows already carry, so a separator or a parent
		// hop means the request did not come from a row — and this ends in a
		// shell open, which is not somewhere to be relaxed about input.
		if (want.find('/') != std::string::npos || want.find('\\') != std::string::npos ||
			want.find("..") != std::string::npos)
			return Dump(json{ { "ok", false }, { "why", "that is not a plain file name" } });

		std::error_code ec;
		std::filesystem::path hit;

		// 1. The physical Data folder — a non-MO2 install, or a file that really
		//    is on disk under the game root.
		{
			const auto direct = std::filesystem::path("Data") / want;
			if (std::filesystem::exists(direct, ec) && !ec)
				hit = std::filesystem::absolute(direct, ec);
		}

		// 2. The MO2 mods root, derived from OUR OWN module path — the VFS-proof
		//    route. ModFolderRoot() is ...\mods\<our mod>; its parent is the mods
		//    root, so every sibling mod folder is a candidate. SPID reads Data's
		//    ROOT only, so the ini sits at <mod>\<name> or <mod>\Data\<name>.
		if (hit.empty()) {
			const auto self = IconBridge::ModFolderRoot();
			if (!self.empty() && self.has_parent_path()) {
				const auto modsRoot = self.parent_path();
				ec.clear();
				for (std::filesystem::directory_iterator it(modsRoot, ec), end;
					 !ec && it != end; it.increment(ec)) {
					std::error_code dec;
					if (!it->is_directory(dec) || dec)
						continue;
					for (const auto& rel : { std::filesystem::path(want),
											 std::filesystem::path("Data") / want }) {
						const auto cand = it->path() / rel;
						std::error_code cec;
						if (std::filesystem::exists(cand, cec) && !cec) {
							hit = cand;
							break;
						}
					}
					if (!hit.empty())
						break;
				}
			}
		}

		if (hit.empty()) {
			logger::info("spid-inspect: open '{}' - no real path found", want);
			return Dump(json{ { "ok", false },
				{ "why", "could not find that file on disk - it may live inside a BSA" } });
		}

		// ShellExecuteW on the RESOLVED, real path. The shell is not inside the
		// game's VFS, which is exactly why the search above had to happen first.
		const auto  wide = hit.wstring();
		const auto  rc = ShellExecuteW(nullptr, L"open", wide.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
		const bool  ok = reinterpret_cast<INT_PTR>(rc) > 32;
		const auto  shown = PathU8(hit);
		logger::info("spid-inspect: open '{}' -> {} ({})", want, shown, ok ? "opened" : "shell refused");
		if (!ok)
			return Dump(json{ { "ok", false }, { "path", shown },
				{ "why", "Windows had no program registered to open it" } });
		return Dump(json{ { "ok", true }, { "path", shown } });
	}

	// ------------------------------------------------------ desktop report --
	//
	// Rober, 2026-08-20: "ability when hitting f7 on an npc to drop a spid
	// report to desktop could be useful for diagnosing leveled list and spid
	// issues."
	//
	// The tab answers "what targets her". A REPORT has to answer the harder
	// question you ask when something is not firing, so it carries three things
	// the pane deliberately summarises away:
	//   * the RAW ini line, as the modder wrote it — spacing, casing, trailing
	//     comment and all. A line rebuilt from parsed sections hides exactly the
	//     typo you are hunting;
	//   * the lines we REJECTED WITHOUT UNDERSTANDING (spid_inspect's honesty
	//     counter). On screen that is a number; here it is the file, the line,
	//     and which token defeated us — which is where a missing master or a
	//     misspelled EditorID actually shows up;
	//   * the NPC's own resolved identity — race, class, keywords, factions,
	//     template chain — because "why did this not match" is usually answered
	//     by something the NPC is not, rather than by the line itself.
	//
	// Plain text on purpose: it is read by a human, grepped, and pasted into a
	// chat. Written to the real Desktop, which is OUTSIDE the VFS, so unlike
	// everything else this module touches the path needs no MO2 reasoning.
	namespace
	{
		// The house idiom (journal.cpp, main.cpp's icon sweep both use it), with
		// fallbacks for a redirected Desktop rather than a silent failure.
		std::filesystem::path DesktopDir()
		{
			const char* prof = std::getenv("USERPROFILE");
			if (!prof || !*prof)
				return {};
			std::error_code     ec;
			const std::filesystem::path home(prof);
			for (const auto& cand : { home / "Desktop", home / "OneDrive" / "Desktop" })
				if (std::filesystem::is_directory(cand, ec) && !ec)
					return cand;
			return home;   // last resort: somewhere real beats nowhere
		}

		std::string NowStamp()
		{
			const auto t = std::time(nullptr);
			std::tm    tm{};
			localtime_s(&tm, &t);
			char buf[32]{};
			std::strftime(buf, sizeof buf, "%Y-%m-%d %H%M%S", &tm);
			return buf;
		}

		// Windows will not take these in a filename, and an NPC name is arbitrary
		// third-party text.
		std::string SafeFileBit(const std::string& in)
		{
			std::string out;
			for (unsigned char c : in) {
				if (c < 32 || std::strchr("\\/:*?\"<>|", c))
					out += '_';
				else
					out += static_cast<char>(c);
			}
			while (!out.empty() && (out.back() == ' ' || out.back() == '.'))
				out.pop_back();
			if (out.empty())
				out = "npc";
			if (out.size() > 60)
				out.resize(60);
			return out;
		}

		void NameList(std::ostringstream& o, const char* label,
			const std::vector<RE::TESForm*>& forms, size_t cap = 40)
		{
			if (forms.empty())
				return;
			o << "  " << label << " (" << forms.size() << ")\n";
			size_t n = 0;
			for (auto* f : forms) {
				if (!f)
					continue;
				if (n++ >= cap) {
					o << "      … and " << (forms.size() - cap) << " more\n";
					break;
				}
				std::string fid, plug;
				ActorIdentity::DurableOf(f, fid, plug);
				o << "      " << ReadableName(f);
				if (!fid.empty())
					o << "   [" << plug << " " << fid << "]";
				o << "\n";
			}
		}

		void OneForm(std::ostringstream& o, const char* label, RE::TESForm* f)
		{
			if (!f)
				return;
			std::string fid, plug;
			ActorIdentity::DurableOf(f, fid, plug);
			o << "  " << std::left << std::setw(14) << label << ReadableName(f);
			if (!fid.empty())
				o << "   [" << plug << " " << fid << "]";
			o << "\n";
		}
	}

	std::string ReportJson(const std::string& reqJson)
	{
		json in = json::object();
		{
			const auto j = json::parse(reqJson, nullptr, false);
			if (!j.is_discarded() && j.is_object())
				in = j;
		}

		KickBuild();
		if (g_state.load() != 2)
			return Dump(json{ { "ok", false }, { "why", "still reading the load order's distribution files - try again in a moment" } });
		if (!RE::PlayerCharacter::GetSingleton())
			return Dump(json{ { "ok", false }, { "why", "no save is loaded" } });

		json       refusal;
		RE::Actor* a = ResolveTarget(in, refusal, 0);
		if (!a)
			return Dump(json{ { "ok", false },
				{ "why", refusal.value("msg", std::string("there is nobody to report on")) } });

		std::ostringstream o;
		try {
			EvaluateFor(a);
			const Ctx c = BuildCtx(a);

			std::string npcName = a->GetName() ? a->GetName() : "";
			if (npcName.empty())
				npcName = ReadableName(c.base);
			std::string fid, plug;
			ActorIdentity::DurableOf(c.base ? static_cast<RE::TESForm*>(c.base) : nullptr, fid, plug);

			o << "SkyManager - SPID / SkyPatcher report\n";
			o << "Generated " << NowStamp() << "\n";
			o << "================================================================\n\n";

			o << "WHO\n";
			o << "  " << std::left << std::setw(14) << "Name" << npcName << "\n";
			if (!fid.empty())
				o << "  " << std::left << std::setw(14) << "Base record" << plug << " " << fid << "\n";
			if (c.base)
				if (const char* ed = c.base->GetFormEditorID(); ed && *ed)
					o << "  " << std::left << std::setw(14) << "EditorID" << ed << "\n";
			OneForm(o, "Race", c.race);
			OneForm(o, "Class", c.cls);
			OneForm(o, "Combat style", c.combatStyle);
			OneForm(o, "Voice", c.voice);
			OneForm(o, "Outfit", c.outfit);
			OneForm(o, "Sleep outfit", c.sleepOutfit);
			o << "  " << std::left << std::setw(14) << "Level" << c.level << "\n";
			o << "  " << std::left << std::setw(14) << "Traits"
			  << (c.female ? "female" : "male")
			  << (c.uniq ? ", unique" : "")
			  << (c.summonable ? ", summonable" : "")
			  << (c.child ? ", child" : "")
			  << (c.leveled ? ", leveled" : "") << "\n";
			o << "\n";
			NameList(o, "Template chain", c.npcs);
			NameList(o, "Factions", c.factions);
			NameList(o, "Keywords", c.keywords, 60);
			o << "\n";

			o << "WHAT WAS SCANNED\n";
			{
				std::lock_guard l(g_mx);
				o << "  " << g_index.spid.size() << " SPID lines in " << g_index.spidFiles << " *_DISTR.ini file(s)\n";
				o << "  " << g_index.sky.size() << " SkyPatcher npc lines in " << g_index.skyFiles << " file(s)"
				  << " (+" << g_index.skyOtherFiles << " SkyPatcher file(s) targeting things other than NPCs)\n";
			}
			o << "\n";

			o << "MATCHED - " << g_eval.rows.size() << " line(s) whose filters this NPC passes\n";
			o << "----------------------------------------------------------------\n";
			for (const auto& r : g_eval.rows) {
				const json& j = r.j;
				o << "\n" << j.value("file", std::string("?")) << ":" << j.value("line", 0)
				  << "   [" << (r.src == 'k' ? "SkyPatcher" : "SPID") << "]\n";
				const std::string raw = j.value("raw", std::string(""));
				if (!raw.empty())
					o << "    | " << raw << "\n";
				o << "    -> " << j.value("type", std::string("?")) << "  "
				  << j.value("label", std::string("?"));
				if (j.contains("plugin"))
					o << "   [" << j.value("plugin", std::string("")) << " "
					  << j.value("formId", std::string("")) << "]";
				o << "\n";
				if (r.src == 'p' && r.chance < 100.0)
					o << "       chance " << r.chance << "%  (a dice roll SPID made at load - it may not have fired)\n";
				if (j.value("unresolvedForm", false))
					o << "       !! the form this hands out is NOT in this load order\n";
				if (j.contains("filters"))
					for (const auto& f : j["filters"])
						o << "       filter " << f.value("k", std::string("")) << " = "
						  << f.value("v", std::string("")) << "\n";
				if (j.contains("uncertain"))
					for (const auto& u : j["uncertain"])
						o << "       ~ " << u.get<std::string>() << "\n";
				if (j.contains("items")) {
					o << "       gives:\n";
					for (const auto& it : j["items"])
						o << "         - " << it.value("name", std::string("?"))
						  << (it.contains("count") ? (" x" + std::to_string(it.value("count", 1))) : "")
						  << "\n";
					if (j.contains("itemsMore"))
						o << "         … and " << j.value("itemsMore", 0) << " more\n";
				}
				/* The leveled-list expansion, which is half the reason this
				   report exists: a row that hands out a LVLI says nothing useful
				   on its own, and "what can this actually roll" is the question. */
				if (j.contains("formId") && j.contains("plugin")) {
					const std::string lv = LeveledJson(Dump(json{
						{ "formId", j.value("formId", std::string("")) },
						{ "plugin", j.value("plugin", std::string("")) } }));
					const auto lj = json::parse(lv, nullptr, false);
					if (!lj.is_discarded() && lj.value("ok", false) && lj.contains("root")) {
						o << "       leveled list - what it can roll:\n";
						std::function<void(const json&, int)> walk = [&](const json& n, int depth) {
							if (depth > 4)
								return;
							for (const auto& kid : n.value("entries", json::array())) {
								o << "         " << std::string(static_cast<size_t>(depth) * 2 + 9, ' ')
								  << "- " << kid.value("name", std::string("?"));
								if (kid.contains("count") && kid.value("count", 1) > 1)
									o << " x" << kid.value("count", 1);
								if (kid.contains("level"))
									o << "  (lvl " << kid.value("level", 0) << "+)";
								o << "\n";
								walk(kid, depth + 1);
							}
						};
						const json& root = lj["root"];
						if (root.contains("chanceNone") && root.value("chanceNone", 0) > 0)
							o << "         " << root.value("chanceNone", 0) << "% chance of nothing at all\n";
						walk(root, 0);
					}
				}
			}
			o << "\n";

			o << "COULD NOT FULLY JUDGE - " << g_eval.undecided << " SPID line(s)\n";
			o << "  These were REJECTED, but at least one of their filters could not be\n";
			o << "  resolved - so the rejection may be wrong. This is where a missing\n";
			o << "  master or a misspelled EditorID shows up.\n";
			o << "----------------------------------------------------------------\n";
			for (const auto& u : g_eval.undecidedRows) {
				o << "\n" << u.file << ":" << u.line << "\n";
				if (!u.raw.empty())
					o << "    | " << u.raw << "\n";
				for (const auto& w : u.why)
					o << "       ~ " << w << "\n";
			}
			if (g_eval.undecided > static_cast<int>(g_eval.undecidedRows.size()))
				o << "\n  … and " << (g_eval.undecided - static_cast<int>(g_eval.undecidedRows.size()))
				  << " more, not listed (report cap)\n";
			o << "\n";
			if (g_eval.unevaluated > 0)
				o << "Plus " << g_eval.unevaluated << " SkyPatcher line(s) using only filters this\n"
				  << "inspector cannot judge - not listed above, and not claimed as matches.\n\n";

			o << "READ THIS BEFORE BLAMING A MOD\n";
			o << "  * A matched line means the NPC passes its FILTERS. It does not mean the\n";
			o << "    thing was handed out: chance is a dice roll SPID made at load.\n";
			o << "  * Of many matched OUTFITS at most one is actually worn - the last one\n";
			o << "    to apply wins, so a matched outfit is a candidate, not a wardrobe.\n";
			o << "  * Race is read from the LIVE actor, so a vampire/werewolf form is a\n";
			o << "    different race record than the base one a mod may target.\n";

			// -------------------------------------------------- write it out --
			const auto dir = DesktopDir();
			if (dir.empty())
				return Dump(json{ { "ok", false }, { "why", "could not find your Desktop folder" } });
			const std::string fname = "SkyManager SPID report - " + SafeFileBit(npcName) +
				" - " + NowStamp() + ".txt";
			const auto out = dir / fname;
			std::ofstream f(out, std::ios::binary | std::ios::trunc);
			if (!f)
				return Dump(json{ { "ok", false }, { "why", "could not write to your Desktop" } });
			const std::string body = o.str();
			f.write(body.data(), static_cast<std::streamsize>(body.size()));
			f.close();

			logger::info("spid-inspect: report written -> {} ({} bytes, {} matched, {} undecided)",
				PathU8(out), body.size(), g_eval.rows.size(), g_eval.undecided);
			return Dump(json{ { "ok", true }, { "path", PathU8(out) },
				{ "bytes", static_cast<int>(body.size()) },
				{ "matched", static_cast<int>(g_eval.rows.size()) },
				{ "undecided", g_eval.undecided },
				{ "name", npcName } });
		} catch (const std::exception& ex) {
			logger::error("spid-inspect: report failed: {}", ex.what());
			return Dump(json{ { "ok", false }, { "why", std::string("the report failed: ") + ex.what() } });
		} catch (...) {
			logger::error("spid-inspect: report failed (unknown)");
			return Dump(json{ { "ok", false }, { "why", "the report failed" } });
		}
	}
}
