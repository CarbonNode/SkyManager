#include "mounts.h"

// pch (force-included) provides RE::/SKSE::, nlohmann json.hpp and logger.

#include "actor_identity.h"
#include "item_icons.h"
#include "npc_actions.h"
#include "spell_actions.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <memory>
#include <mutex>
#include <thread>
#include <unordered_set>
#include <vector>

namespace Mounts
{
	namespace
	{
		using json = nlohmann::json;

		/* ── the stable, file-backed ────────────────────────────────────────── */

		struct Mount
		{
			std::string id;         // "m<counter>" — stable within this file
			std::string kind;       // "spell" | "actor"
			std::string name;       // display name (rename applies here)
			bool        fav{ false };
			std::string note;
			std::string cat;        // user category id ("" = uncategorised)
			// spell kind — the summon's durable identity
			std::string spPlugin, spId;
			// the NPC this row IS (conjured, or the crosshair actor's base):
			// what renders, and what ride-after-summon watches for
			std::string npPlugin, npId;
			// actor kind — the placed reference (empty for a dynamic ref;
			// those resolve by base scan instead)
			std::string refPlugin, refId;
		};

		// A user category is a label with a stable id and a display name. It
		// owns NOTHING — a mount's `cat` points at it — so deleting one just
		// refiles the mounts pointing at it back to uncategorised. Order in the
		// vector IS the rail order.
		struct Category
		{
			std::string id;         // "c<counter>" — stable within this file
			std::string name;
		};

		struct Config
		{
			std::vector<Mount>    mounts;
			std::vector<Category> categories;
			std::uint64_t         counter{ 1 };     // mount ids
			std::uint64_t         catCounter{ 1 };  // category ids
			// Free-form view preferences (picker sort, …). Stored as a raw json
			// object so a key a newer view adds round-trips through an older DLL
			// untouched — the anim-pane anUser lesson, but inside this module's
			// own file. Kept as an object; anything non-object on disk resets it.
			json                  prefs = json::object();
		};

		std::mutex g_m;         // guards g_cfg + g_loaded only (file state)
		Config     g_cfg;
		bool       g_loaded = false;

		std::filesystem::path FilePath()
		{
			return std::filesystem::path("Data") / "SKSE" / "Plugins" / "HotkeyDeck" / "mounts.json";
		}

		json MountToJson(const Mount& m)
		{
			return json{ { "id", m.id }, { "kind", m.kind }, { "name", m.name },
				{ "fav", m.fav }, { "note", m.note }, { "cat", m.cat },
				{ "spPlugin", m.spPlugin }, { "spId", m.spId },
				{ "npPlugin", m.npPlugin }, { "npId", m.npId },
				{ "refPlugin", m.refPlugin }, { "refId", m.refId } };
		}

		// g_m held. A cat id that points at no category is treated as
		// uncategorised (a hand-edited file, or a category deleted out from
		// under a mount by an older tool). Cheap linear scan — the list is tiny.
		bool CatExistsLocked(const std::string& id)
		{
			if (id.empty())
				return true;
			for (const auto& c : g_cfg.categories)
				if (c.id == id)
					return true;
			return false;
		}

		// g_m held. Tolerant of a hand-edited or older file: unknown keys are
		// ignored, missing ones default, and a row with no identity at all is
		// dropped (it could never resolve to anything).
		void LoadLocked()
		{
			if (g_loaded)
				return;
			g_loaded = true;
			std::ifstream in(FilePath(), std::ios::binary);
			if (!in.is_open()) {
				logger::info("mounts: stable loaded - empty (no mounts.json yet)");
				return;
			}
			auto j = json::parse(in, nullptr, false);
			if (j.is_discarded() || !j.is_object()) {
				logger::warn("mounts: mounts.json did not parse - starting empty (file kept on disk)");
				return;
			}
			g_cfg.counter    = j.value("counter", std::uint64_t{ 1 });
			g_cfg.catCounter = j.value("catCounter", std::uint64_t{ 1 });
			// View prefs — a raw object round-tripped verbatim. Tolerant of a
			// missing or malformed key: default to an empty object.
			if (j.contains("prefs") && j["prefs"].is_object())
				g_cfg.prefs = j["prefs"];
			// Categories first — the rail order IS array order, and a mount's
			// cat has to resolve against them.
			if (j.contains("categories") && j["categories"].is_array()) {
				for (const auto& e : j["categories"]) {
					if (!e.is_object())
						continue;
					Category c;
					c.id   = e.value("id", std::string());
					c.name = e.value("name", std::string());
					if (c.id.empty() || c.name.empty())
						continue;
					// Refuse a duplicate id — a hand-edited file could collide.
					if (CatExistsLocked(c.id))
						continue;
					g_cfg.categories.push_back(std::move(c));
				}
			}
			if (j.contains("mounts") && j["mounts"].is_array()) {
				for (const auto& e : j["mounts"]) {
					if (!e.is_object())
						continue;
					Mount m;
					m.id        = e.value("id", std::string());
					m.kind      = e.value("kind", std::string());
					m.name      = e.value("name", std::string());
					m.fav       = e.value("fav", false);
					m.note      = e.value("note", std::string());
					m.cat       = e.value("cat", std::string());
					m.spPlugin  = e.value("spPlugin", std::string());
					m.spId      = e.value("spId", std::string());
					m.npPlugin  = e.value("npPlugin", std::string());
					m.npId      = e.value("npId", std::string());
					m.refPlugin = e.value("refPlugin", std::string());
					m.refId     = e.value("refId", std::string());
					if (m.kind != "spell" && m.kind != "actor")
						continue;
					if (m.spId.empty() && m.npId.empty() && m.refId.empty())
						continue;
					// A cat pointing at a deleted/unknown category is dropped to
					// uncategorised rather than left dangling.
					if (!CatExistsLocked(m.cat))
						m.cat.clear();
					if (m.id.empty())
						m.id = "m" + std::to_string(g_cfg.counter++);
					g_cfg.mounts.push_back(std::move(m));
				}
			}
			logger::info("mounts: stable loaded - {} mount(s), {} category(ies)",
				g_cfg.mounts.size(), g_cfg.categories.size());
		}

		// g_m held. The hotkeys.json discipline in miniature: serialise first,
		// keep one .bak, write a sibling temp, rename over (atomic on NTFS).
		void SaveLocked()
		{
			json j;
			j["version"]    = 1;
			j["counter"]    = g_cfg.counter;
			j["catCounter"] = g_cfg.catCounter;
			j["prefs"]      = g_cfg.prefs.is_object() ? g_cfg.prefs : json::object();
			auto cats = json::array();
			for (const auto& c : g_cfg.categories)
				cats.push_back(json{ { "id", c.id }, { "name", c.name } });
			j["categories"] = cats;
			auto arr = json::array();
			for (const auto& m : g_cfg.mounts)
				arr.push_back(MountToJson(m));
			j["mounts"] = arr;
			std::string text;
			try {
				text = j.dump(2, ' ', false, json::error_handler_t::replace);
			} catch (...) {
				logger::error("mounts: serialise failed - mounts.json NOT written");
				return;
			}
			const auto      path = FilePath();
			std::error_code ec;
			std::filesystem::create_directories(path.parent_path(), ec);
			if (std::filesystem::exists(path, ec)) {
				auto bak = path;
				bak.replace_extension(".bak");
				std::filesystem::copy_file(path, bak,
					std::filesystem::copy_options::overwrite_existing, ec);
			}
			auto tmp = path;
			tmp += ".tmp";
			{
				std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
				if (!out.is_open()) {
					logger::error("mounts: could not open {} for write", tmp.string());
					return;
				}
				out << text;
			}
			std::filesystem::rename(tmp, path, ec);
			if (ec)
				logger::error("mounts: atomic replace failed: {}", ec.message());
		}

		Mount* FindLocked(const std::string& id)
		{
			for (auto& m : g_cfg.mounts)
				if (m.id == id)
					return &m;
			return nullptr;
		}

		/* ── engine lookups (main thread) ───────────────────────────────────── */

		std::string LowerS(std::string s)
		{
			for (auto& c : s)
				c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
			return s;
		}

		RE::TESNPC* NpcOf(const Mount& m)
		{
			if (m.npId.empty())
				return nullptr;
			auto* f = ActorIdentity::Resolve(m.npId, m.npPlugin);
			return f ? f->As<RE::TESNPC>() : nullptr;
		}

		RE::SpellItem* SpellOf(const Mount& m)
		{
			if (m.spId.empty())
				return nullptr;
			auto* f = ActorIdentity::Resolve(m.spId, m.spPlugin);
			return f ? f->As<RE::SpellItem>() : nullptr;
		}

		// Does this actor's base answer to the mount's stored NPC identity?
		bool BaseMatches(RE::Actor* a, const Mount& m)
		{
			if (!a || m.npId.empty())
				return false;
			auto* base = a->GetActorBase();
			if (!base)
				return false;
			std::string fid, plug;
			if (ActorIdentity::DurableOf(base, fid, plug))
				return ActorIdentity::ParseHex(fid) == ActorIdentity::ParseHex(m.npId) &&
				       LowerS(plug) == LowerS(m.npPlugin);
			return false;
		}

		/* The live actor a row means. The durable ref resolves a placed horse
		 * even from another cell (persistent refs answer LookupFormID whether
		 * or not their cell is attached); a summoned/dynamic one has no durable
		 * ref, so the loaded world is scanned for the BASE — nearest first,
		 * skipping the dead. */
		RE::Actor* FindActorFor(const Mount& m)
		{
			if (!m.refId.empty())
				if (auto* a = ActorIdentity::ResolveActor(m.refId, m.refPlugin))
					return a;
			if (m.npId.empty())
				return nullptr;
			auto* pl = RE::ProcessLists::GetSingleton();
			auto* player = RE::PlayerCharacter::GetSingleton();
			if (!pl || !player)
				return nullptr;
			RE::Actor* best = nullptr;
			float      bestD = 0.0f;
			for (auto& h : pl->highActorHandles) {
				auto a = h.get();
				if (!a || a->IsDead())
					continue;
				if (!BaseMatches(a.get(), m))
					continue;
				const float d = a->GetPosition().GetDistance(player->GetPosition());
				if (!best || d < bestD) {
					best  = a.get();
					bestD = d;
				}
			}
			return best;
		}

		/* The body NIF — the Dragon Roost route, stated once: an actor's
		 * visible body IS its skin ARMO's armor-addon biped model for its race
		 * and sex. npc->skin (per-NPC override) -> race->skin (the species) ->
		 * npc->farSkin, first model wins; GetArmorAddon does the race walk
		 * (additional races included). */
		std::string BodyNifOf(RE::TESNPC* npc)
		{
			if (!npc)
				return {};
			auto* race = npc->race;
			if (!race)
				return {};
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
				// Belt and braces: any addon of this armour with any model.
				for (auto* ad : armo->armorAddons) {
					if (!ad)
						continue;
					for (const auto& bm : ad->bipedModels)
						if (const char* mdl = bm.GetModel(); mdl && *mdl)
							return mdl;
				}
				return {};
			};
			if (auto s = fromArmor(npc->skin); !s.empty())
				return s;
			if (auto s = fromArmor(race->skin); !s.empty())
				return s;
			if (auto s = fromArmor(npc->farSkin); !s.empty())
				return s;
			return {};
		}

		/* The record-level auto-detect: the first summon effect's associated
		 * form. This is the engine's OWN "who appears" pointer (what the
		 * Conjuration archetype spawns), so a hit is authoritative; a miss
		 * (script-driven summons) is reported as "the record can't see it",
		 * never guessed at. */
		RE::TESNPC* ConjuredNpcOf(RE::SpellItem* spell)
		{
			if (!spell)
				return nullptr;
			for (auto* eff : spell->effects) {
				if (!eff || !eff->baseEffect)
					continue;
				if (eff->baseEffect->GetArchetype() != RE::EffectSetting::Archetype::kSummonCreature)
					continue;
				auto* assoc = eff->baseEffect->data.associatedForm;
				if (!assoc)
					continue;
				if (auto* npc = assoc->As<RE::TESNPC>())
					return npc;
			}
			return nullptr;
		}

		// Purely a label helper — the game itself decides what can be ridden
		// (activation either mounts or it doesn't), so this only tunes the UI.
		bool LooksRideable(RE::TESRace* race)
		{
			if (!race)
				return false;
			std::string s;
			if (const char* n = race->GetName(); n && *n)
				s += LowerS(n);
			if (const char* e = race->GetFormEditorID(); e && *e) {
				s += ' ';
				s += LowerS(e);
			}
			static const char* kHints[] = { "horse", "steed", "mount", "pony", "mare",
				"stallion", "unicorn", "deer", "elk", "dragon", "mammoth", "bear",
				"wolf", "boar", "goat", "camel", "sabre", "tiger", "chaurus" };
			for (const auto* h : kHints)
				if (s.find(h) != std::string::npos)
					return true;
			return false;
		}

		std::string RaceNameOf(RE::TESNPC* npc)
		{
			auto*       race = npc ? npc->race : nullptr;
			const char* n = race ? race->GetName() : nullptr;
			return (n && *n) ? n : "";
		}

		/* ── ride-after-summon: watch for the conjured NPC, then mount it ───
		 * The cast happens in the live world and the creature takes a moment
		 * to land, so a detached thread posts one bounded scan per beat and
		 * the moment an actor with the right base is close, loaded and alive,
		 * it is ACTIVATED as the player — the exact thing pressing E on it
		 * does, so whatever the mount's own mod wires to being mounted runs
		 * untouched. One watcher at a time; a second ride while one is
		 * looking is refused rather than raced. */
		std::atomic<bool> g_watching{ false };

		void ActivateMount(RE::Actor* a)
		{
			auto* player = RE::PlayerCharacter::GetSingleton();
			if (!a || !player)
				return;
			logger::info("mounts: mounting '{}'", a->GetDisplayFullName());
			a->ActivateRef(player, 0, nullptr, 1, false);
		}

		// Post-cast (and post-call) watcher. `m` is a snapshot copy — the
		// config can mutate freely while this looks.
		void StartMountWatch(Mount m, int beats)
		{
			if (g_watching.exchange(true))
				return;
			auto state = std::make_shared<std::atomic<int>>(0);   // 0 looking · 1 done
			std::thread([m = std::move(m), beats, state]() {
				using namespace std::chrono_literals;
				for (int i = 0; i < beats; ++i) {
					std::this_thread::sleep_for(250ms);
					if (state->load() != 0)
						break;
					const bool last = (i == beats - 1);
					SKSE::GetTaskInterface()->AddTask([m, state, last]() {
						if (state->load() != 0)
							return;
						auto* player = RE::PlayerCharacter::GetSingleton();
						if (!player)
							return;
						{   // already up? someone mounted meanwhile — stop looking
							RE::NiPointer<RE::Actor> cur;
							if (player->GetMount(cur) && cur) {
								state->store(1);
								return;
							}
						}
						auto* a = FindActorFor(m);
						if (a && a->Is3DLoaded() && !a->IsDead() &&
							a->GetPosition().GetDistance(player->GetPosition()) < 4096.0f) {
							RE::NiPointer<RE::Actor> rider;
							if (a->GetMountedBy(rider) && rider)
								return;   // taken — keep looking for another
							state->store(1);
							ActivateMount(a);
							return;
						}
						if (last)
							RE::DebugNotification(
								("🐴 " + (m.name.empty() ? std::string("Your mount") : m.name) +
									" never arrived close enough to mount").c_str());
					});
				}
				g_watching = false;
			}).detach();
		}

		/* ── shared add machinery ───────────────────────────────────────────── */

		std::string Refuse(const std::string& act, const std::string& msg)
		{
			return json{ { "ok", false }, { "act", act }, { "found", false }, { "msg", msg } }
				.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		json StateRowLocked(const Mount& m)
		{
			// g_m held for the stored fields; the engine reads below are
			// main-thread facts, not file state.
			json o;
			o["id"]   = m.id;
			o["kind"] = m.kind;
			o["fav"]  = m.fav;
			o["note"] = m.note;
			o["cat"]  = m.cat;
			auto* npc = NpcOf(m);
			o["name"] = !m.name.empty() ? m.name
			            : npc           ? std::string(npc->GetName())
			                            : std::string("Unknown mount");
			o["race"]     = RaceNameOf(npc);
			o["rideable"] = npc ? LooksRideable(npc->race) : false;
			// The NPC identity rides along so the view can key late-landing
			// renders (mtIconsData) back onto this row — the C++ KeyOf shape.
			o["npId"]     = m.npId;
			o["npPlugin"] = m.npPlugin;
			o["img"]      = m.npId.empty() ? "" : ItemIcons::BodyPathFor(m.npId, m.npPlugin);
			o["plug"]     = m.kind == "spell" ? m.spPlugin : (!m.refPlugin.empty() ? m.refPlugin : m.npPlugin);
			if (m.kind == "spell") {
				auto* spell = SpellOf(m);
				o["spName"] = spell ? spell->GetName() : "";
				auto* player = RE::PlayerCharacter::GetSingleton();
				o["known"]  = spell && player && player->HasSpell(spell);
				o["npKnown"] = !m.npId.empty();
			} else {
				auto* a = FindActorFor(m);
				o["loaded"] = a && a->Is3DLoaded();
				o["dead"]   = a && a->IsDead();
				o["found"]  = a != nullptr;
				if (a) {
					if (auto* player = RE::PlayerCharacter::GetSingleton())
						o["near"] = a->GetPosition().GetDistance(player->GetPosition()) < 4096.0f;
				}
			}
			return o;
		}
	}

	/* ── the bridge faces ──────────────────────────────────────────────────── */

	std::string StateJson()
	{
		json rows = json::array();
		json cats = json::array();
		json prefs = json::object();
		json riding = nullptr;
		{
			std::lock_guard l(g_m);
			LoadLocked();
			prefs = g_cfg.prefs.is_object() ? g_cfg.prefs : json::object();
			for (const auto& c : g_cfg.categories)
				cats.push_back(json{ { "id", c.id }, { "name", c.name } });
			for (const auto& m : g_cfg.mounts)
				rows.push_back(StateRowLocked(m));
			// Who are you on right now? Matched back to a row where possible,
			// named regardless — the header chip should never lie by omission.
			if (auto* player = RE::PlayerCharacter::GetSingleton()) {
				RE::NiPointer<RE::Actor> cur;
				if (player->GetMount(cur) && cur) {
					riding = json{ { "name", cur->GetDisplayFullName() }, { "id", "" } };
					for (const auto& m : g_cfg.mounts)
						if (BaseMatches(cur.get(), m)) {
							riding["id"] = m.id;
							break;
						}
					for (auto& r : rows)
						if (r.value("id", std::string()) == riding.value("id", std::string()) &&
							!r.value("id", std::string()).empty())
							r["riding"] = true;
				}
			}
		}
		return json{ { "mrf", ItemIcons::Available() }, { "count", rows.size() },
			{ "riding", std::move(riding) }, { "categories", std::move(cats) },
			{ "prefs", std::move(prefs) }, { "mounts", std::move(rows) } }
			.dump(-1, ' ', false, json::error_handler_t::replace);
	}

	/* ── candidate classification (feature 1: nothing summon-shaped is ever
	 *    unfindable) ────────────────────────────────────────────────────────
	 * The old picker only ever saw the spells the player ALREADY KNEW, so a
	 * just-learned summon-horse spell — or one still sitting unread in a tome
	 * (Rober, 2026-08-14: "i just learned a summon horse spell, searching shows
	 * no such spell") — simply did not exist in the list. The catalogue half
	 * below sweeps the WHOLE load order for anything that could plausibly be a
	 * mount summon and marks it known:false, so it is findable and addable
	 * whether or not it is in the spellbook yet. Deliberately broad: a false
	 * positive is one extra row the search filters away; a false negative is an
	 * invisible spell, which is the bug. */

	bool NameHasSummonWord(const std::string& lower)
	{
		static const char* kWords[] = { "summon", "conjure", "call", "steed",
			"mount", "horse", "raise", "reanimat", "familiar", "atronach",
			"dremora", "thrall" };
		for (const auto* w : kWords)
			if (lower.find(w) != std::string::npos)
				return true;
		return false;
	}

	// Does any effect on this spell summon/reanimate a creature, or does any
	// effect's NAME read like a summon? (An effect name catches the scripted
	// summons whose archetype is a plain Script — the Stalhorse case: a
	// SummonCreature archetype with a NULL associatedForm, driven by Papyrus.)
	bool EffectsLookSummony(RE::SpellItem* spell)
	{
		if (!spell)
			return false;
		for (auto* eff : spell->effects) {
			auto* base = eff ? eff->baseEffect : nullptr;
			if (!base)
				continue;
			const auto a = base->GetArchetype();
			if (a == RE::EffectSetting::Archetype::kSummonCreature ||
				a == RE::EffectSetting::Archetype::kReanimate)
				return true;
			if (const char* en = base->GetFullName(); en && *en)
				if (NameHasSummonWord(LowerS(en)))
					return true;
		}
		return false;
	}

	bool IsConjurationSpell(RE::SpellItem* spell)
	{
		if (!spell)
			return false;
		for (auto* eff : spell->effects) {
			auto* base = eff ? eff->baseEffect : nullptr;
			if (base && base->GetMagickSkill() == RE::ActorValue::kConjuration)
				return true;
		}
		return false;
	}

	// The broad candidate test: a summon-shaped name, OR a summon/reanimate
	// effect, OR a Conjuration spell. Any one is enough. Name first — it is a
	// cheap substring scan, so the whole-array sweep skips the effect walks for
	// the vast majority of spells (which are neither).
	bool IsSummonCandidate(RE::SpellItem* spell)
	{
		if (!spell)
			return false;
		if (const char* n = spell->GetName(); n && *n && NameHasSummonWord(LowerS(n)))
			return true;
		if (EffectsLookSummony(spell))
			return true;
		if (IsConjurationSpell(spell))
			return true;
		return false;
	}

	const char* SchoolNameAV(RE::ActorValue av)
	{
		switch (av) {
		case RE::ActorValue::kAlteration:  return "alteration";
		case RE::ActorValue::kConjuration: return "conjuration";
		case RE::ActorValue::kDestruction: return "destruction";
		case RE::ActorValue::kIllusion:    return "illusion";
		case RE::ActorValue::kRestoration: return "restoration";
		default:                           return "";
		}
	}

	// The picker draws real Spell-Hotbar art, which needs the same metadata the
	// Spell Deck feeds hdSpellIconPath. KnownSpellsJson already carries it for
	// KNOWN spells; for catalogue candidates we compute it here with the SAME
	// public reads spell_actions' FillIconMeta/TierOf use (they live in another
	// TU's anon namespace, so this is a faithful mirror): GetAssociatedSkill for
	// the school, the costliest AV effect for element/archetype, minimumSkill
	// for the tier. Fills school/element/archetype/tier/slot on `o`.
	void FillSpellMeta(RE::SpellItem* s, json& o)
	{
		o["school"]    = "";
		o["element"]   = "";
		o["archetype"] = "";
		o["tier"]      = "";
		o["slot"]      = "hand";
		if (!s)
			return;
		const bool hand = s->GetSpellType() == RE::MagicSystem::SpellType::kSpell;
		o["slot"] = hand ? "hand" : "voice";
		std::string school;
		if (auto skill = s->GetAssociatedSkill(); skill != RE::ActorValue::kNone)
			school = SchoolNameAV(skill);
		if (auto* eff = s->GetAVEffect()) {
			switch (eff->data.resistVariable) {
			case RE::ActorValue::kResistFire:  o["element"] = "fire"; break;
			case RE::ActorValue::kResistFrost: o["element"] = "frost"; break;
			case RE::ActorValue::kResistShock: o["element"] = "shock"; break;
			default: break;
			}
			switch (eff->GetArchetype()) {
			case RE::EffectSetting::Archetype::kBoundWeapon:    o["archetype"] = "bound"; break;
			case RE::EffectSetting::Archetype::kSummonCreature: o["archetype"] = "summon"; break;
			case RE::EffectSetting::Archetype::kReanimate:      o["archetype"] = "reanimate"; break;
			case RE::EffectSetting::Archetype::kLight:          o["archetype"] = "light"; break;
			default: break;
			}
			if (school.empty())
				school = SchoolNameAV(eff->GetMagickSkill());
		}
		o["school"] = school;
		if (hand) {
			const auto* eff  = s->GetCostliestEffectItem();
			const auto* base = eff ? eff->baseEffect : nullptr;
			const auto  min  = base ? base->data.minimumSkill : 0;
			o["tier"] = min >= 100 ? "master" : min >= 75 ? "expert" : min >= 50 ? "adept"
				: min >= 25       ? "apprentice"
				                  : "novice";
		}
	}

	// The conjured-NPC facet, shared by both halves (auto-detect off the
	// record's own kSummonCreature associatedForm — null when a script does it).
	void FillConjured(RE::SpellItem* spell, json& o)
	{
		o["np"] = nullptr;
		if (auto* npc = ConjuredNpcOf(spell)) {
			std::string fid, plug;
			if (ActorIdentity::DurableOf(npc, fid, plug))
				o["np"] = json{ { "name", npc->GetName() }, { "race", RaceNameOf(npc) },
					{ "rideable", LooksRideable(npc->race) }, { "plugin", plug }, { "id", fid } };
		}
	}

	std::string SpellsJson()
	{
		json out = json::array();
		std::unordered_set<std::uint32_t> seen;   // formIds already emitted

		// ── half 1: every KNOWN spell, marked known:true. The proven
		//    enumeration, so the picker and the Spell Deck can never disagree
		//    about what "known" means; its rows already carry the icon metadata.
		auto known = json::parse(SpellActions::KnownSpellsJson(), nullptr, false);
		if (known.is_array()) {
			for (auto& row : known) {
				if (!row.is_object())
					continue;
				const auto fid = row.value("formId", 0u);
				if (fid && !seen.insert(fid).second)
					continue;
				json o;
				o["plugin"]    = row.value("plugin", std::string());
				o["localId"]   = row.value("localId", 0u);
				o["formId"]    = fid;
				o["name"]      = row.value("name", std::string());
				o["school"]    = row.value("school", std::string());
				o["element"]   = row.value("element", std::string());
				o["archetype"] = row.value("archetype", std::string());
				o["tier"]      = row.value("tier", std::string());
				o["slot"]      = row.value("slot", std::string());
				o["known"]     = true;
				o["np"]        = nullptr;
				RE::TESForm* f = nullptr;
				if (const auto plug = o["plugin"].get<std::string>(); !plug.empty())
					if (auto* dh = RE::TESDataHandler::GetSingleton())
						f = dh->LookupForm(o["localId"].get<std::uint32_t>(), plug);
				if (!f && fid)
					f = RE::TESForm::LookupByID(fid);
				if (auto* spell = f ? f->As<RE::SpellItem>() : nullptr)
					FillConjured(spell, o);
				out.push_back(std::move(o));
			}
		}

		// ── half 2: catalogue candidates — every summon-shaped SpellItem in the
		//    load order the player does NOT already know, marked known:false.
		//    This is what makes an unread/unlearned summon-horse findable. Bounded
		//    by the candidate test (a whole-array walk is fine; TESForm arrays are
		//    already in memory and this only runs when the picker opens).
		auto* dh     = RE::TESDataHandler::GetSingleton();
		auto* player = RE::PlayerCharacter::GetSingleton();
		if (dh) {
			for (auto* s : dh->GetFormArray<RE::SpellItem>()) {
				if (!s)
					continue;
				const auto type = s->GetSpellType();
				using T = RE::MagicSystem::SpellType;
				if (type != T::kSpell && type != T::kPower && type != T::kLesserPower &&
					type != T::kVoicePower)
					continue;                                   // not castable at all
				const char* nm = s->GetName();
				if (!nm || !*nm)
					continue;                                   // nameless — unpickable
				const auto fid = s->GetFormID();
				if (seen.count(fid))
					continue;                                   // already emitted (known)
				if (player && player->HasSpell(s))
					continue;                                   // known: half 1 owns it
				if (!IsSummonCandidate(s))
					continue;
				seen.insert(fid);
				std::string durFid, durPlug;
				ActorIdentity::DurableOf(s, durFid, durPlug);   // plugin + local hex
				json o;
				o["plugin"]  = durPlug;
				o["localId"] = ActorIdentity::LocalIdOf(s);
				o["formId"]  = fid;
				o["name"]    = nm;
				o["known"]   = false;
				FillSpellMeta(s, o);
				FillConjured(s, o);
				out.push_back(std::move(o));
			}
		}

		// Rebuilt from scratch here on every picker open (and manual ⟳), so a
		// spell learned mid-session appears and every known-flag is live.
		logger::info("mounts: summon candidates rebuilt (picker open) - {} total (known + catalogue)",
			out.size());
		return json{ { "spells", std::move(out) } }
			.dump(-1, ' ', false, json::error_handler_t::replace);
	}

	std::string ActJson(const std::string& req)
	{
		const auto j = json::parse(req, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return Refuse("", "Bad request");
		const auto act = j.value("act", std::string());
		const auto id  = j.value("id", std::string());

		const auto okRow = [&](const Mount& m, const std::string& msg) {
			json o = json{ { "ok", true }, { "act", act }, { "found", true }, { "msg", msg } };
			std::lock_guard l(g_m);
			o["mount"] = StateRowLocked(m);
			return o.dump(-1, ' ', false, json::error_handler_t::replace);
		};

		if (act == "addLook") {
			const auto tid = NpcActions::TargetFormID();
			auto*      a = tid ? RE::TESForm::LookupByID<RE::Actor>(tid) : nullptr;
			if (!a)
				return Refuse(act, "Look at a horse or beast, then open the deck and add it");
			if (a->IsPlayerRef())
				return Refuse(act, "You cannot ride yourself");
			if (a->IsDead())
				return Refuse(act, "That one is dead - not much of a mount");
			auto* base = a->GetActorBase();
			Mount m;
			m.kind = "actor";
			ActorIdentity::DurableOf(a, m.refId, m.refPlugin);       // "" for a summon - honest
			if (base)
				ActorIdentity::DurableOf(base, m.npId, m.npPlugin);
			if (m.refId.empty() && m.npId.empty())
				return Refuse(act, "That creature is fully dynamic - nothing durable to store");
			const char* nm = a->GetDisplayFullName();
			m.name = (nm && *nm) ? nm : "Mount";
			std::string newId;
			{
				std::lock_guard l(g_m);
				LoadLocked();
				for (const auto& e : g_cfg.mounts) {
					if (e.kind != "actor")
						continue;
					if (!m.refId.empty() && e.refId == m.refId &&
						LowerS(e.refPlugin) == LowerS(m.refPlugin))
						return Refuse(act, m.name + " is already in your stable");
					// A summoned one has no ref - the base is its identity.
					if (m.refId.empty() && e.refId.empty() && !m.npId.empty() &&
						ActorIdentity::ParseHex(e.npId) == ActorIdentity::ParseHex(m.npId) &&
						LowerS(e.npPlugin) == LowerS(m.npPlugin))
						return Refuse(act, m.name + " is already in your stable");
				}
				m.id = newId = "m" + std::to_string(g_cfg.counter++);
				g_cfg.mounts.push_back(m);
				SaveLocked();
			}
			logger::info("mounts: added '{}' from the crosshair", m.name);
			EnsureRenders();
			return okRow(m, "🐴 " + m.name + " joins your stable");
		}

		if (act == "addSpell") {
			const auto          plug = j.value("plugin", std::string());
			const std::uint32_t local = j.value("localId", 0u);
			const std::uint32_t formId = j.value("formId", 0u);
			RE::TESForm*        f = nullptr;
			if (!plug.empty())
				if (auto* dh = RE::TESDataHandler::GetSingleton())
					f = dh->LookupForm(local, plug);
			if (!f && formId)
				f = RE::TESForm::LookupByID(formId);
			auto* spell = f ? f->As<RE::SpellItem>() : nullptr;
			if (!spell)
				return Refuse(act, "That spell no longer resolves in this load order");
			Mount m;
			m.kind = "spell";
			ActorIdentity::DurableOf(spell, m.spId, m.spPlugin);
			if (m.spId.empty())
				return Refuse(act, "That spell has no durable identity to store");
			auto* npc = ConjuredNpcOf(spell);
			if (npc)
				ActorIdentity::DurableOf(npc, m.npId, m.npPlugin);
			m.name = npc ? npc->GetName() : spell->GetName();
			{
				std::lock_guard l(g_m);
				LoadLocked();
				for (const auto& e : g_cfg.mounts)
					if (e.kind == "spell" &&
						ActorIdentity::ParseHex(e.spId) == ActorIdentity::ParseHex(m.spId) &&
						LowerS(e.spPlugin) == LowerS(m.spPlugin))
						return Refuse(act, std::string(spell->GetName()) + " is already in your stable");
				m.id = "m" + std::to_string(g_cfg.counter++);
				g_cfg.mounts.push_back(m);
				SaveLocked();
			}
			logger::info("mounts: added summon '{}' (conjures: {})", spell->GetName(),
				npc ? npc->GetName() : "nothing the record can see");
			EnsureRenders();
			return okRow(m,
				npc ? ("✨ " + m.name + " - conjured by " + spell->GetName())
					: ("✨ " + m.name + " added - its record hides what it conjures, so Ride will just cast it"));
		}

		if (act == "remove" || act == "fav" || act == "rename" || act == "note" || act == "setCat") {
			std::lock_guard l(g_m);
			LoadLocked();
			auto* m = FindLocked(id);
			if (!m)
				return Refuse(act, "That mount is no longer in the stable");
			std::string msg;
			if (act == "remove") {
				const auto name = m->name;
				g_cfg.mounts.erase(g_cfg.mounts.begin() + (m - g_cfg.mounts.data()));
				SaveLocked();
				return json{ { "ok", true }, { "act", act }, { "found", true },
					{ "msg", name + " released from the stable" } }
					.dump(-1, ' ', false, json::error_handler_t::replace);
			}
			if (act == "fav") {
				m->fav = j.value("on", !m->fav);
				msg = m->fav ? "★ Favourite" : "Unfavourited";
			} else if (act == "rename") {
				auto name = j.value("name", std::string());
				if (name.size() > 64)
					name.resize(64);
				if (!name.empty())
					m->name = name;
				msg = "Renamed";
			} else if (act == "setCat") {
				// Move this mount into a category (or "" for uncategorised). An
				// unknown id is refused rather than silently blanked — a stale
				// drag target should say so, not lose the intent.
				auto cat = j.value("cat", std::string());
				if (!CatExistsLocked(cat))
					return Refuse(act, "That category no longer exists");
				m->cat = cat;
				std::string cn;
				for (const auto& c : g_cfg.categories)
					if (c.id == cat) {
						cn = c.name;
						break;
					}
				msg = cat.empty() ? "Moved to Uncategorised" : ("Moved to " + cn);
			} else {
				auto note = j.value("note", std::string());
				if (note.size() > 300)
					note.resize(300);
				m->note = note;
				msg = "Note saved";
			}
			SaveLocked();
			const Mount copy = *m;
			// okRow re-locks; release first by scoping — simplest is to build here.
			json o = json{ { "ok", true }, { "act", act }, { "found", true }, { "msg", msg } };
			o["mount"] = StateRowLocked(copy);
			return o.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		/* ── category management (feature 3) ─────────────────────────────────
		 * A category is a label with a stable id. Creating, renaming, reordering
		 * and deleting them never touches a mount's own data; deleting one
		 * refiles its mounts to uncategorised. Every one of these returns ok so
		 * the pane re-asks mtState and repaints its rail from truth. */
		if (act == "catAdd") {
			auto name = j.value("name", std::string());
			if (name.size() > 40)
				name.resize(40);
			// trim
			while (!name.empty() && (name.front() == ' ' || name.front() == '\t'))
				name.erase(name.begin());
			while (!name.empty() && (name.back() == ' ' || name.back() == '\t'))
				name.pop_back();
			if (name.empty())
				return Refuse(act, "Give the category a name");
			std::lock_guard l(g_m);
			LoadLocked();
			if (g_cfg.categories.size() >= 64)
				return Refuse(act, "That is a lot of categories - 64 is the cap");
			for (const auto& c : g_cfg.categories)
				if (LowerS(c.name) == LowerS(name))
					return Refuse(act, "You already have a category called " + c.name);
			Category c;
			c.id   = "c" + std::to_string(g_cfg.catCounter++);
			c.name = name;
			g_cfg.categories.push_back(c);
			SaveLocked();
			logger::info("mounts: category '{}' added", name);
			return json{ { "ok", true }, { "act", act }, { "found", true }, { "id", c.id },
				{ "msg", "Category " + name + " added" } }
				.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		if (act == "catRename") {
			const auto cid = j.value("cat", std::string());
			auto       name = j.value("name", std::string());
			if (name.size() > 40)
				name.resize(40);
			while (!name.empty() && (name.front() == ' ' || name.front() == '\t'))
				name.erase(name.begin());
			while (!name.empty() && (name.back() == ' ' || name.back() == '\t'))
				name.pop_back();
			if (name.empty())
				return Refuse(act, "A category needs a name");
			std::lock_guard l(g_m);
			LoadLocked();
			Category* target = nullptr;
			for (auto& c : g_cfg.categories)
				if (c.id == cid)
					target = &c;
			if (!target)
				return Refuse(act, "That category no longer exists");
			for (const auto& c : g_cfg.categories)
				if (&c != target && LowerS(c.name) == LowerS(name))
					return Refuse(act, "You already have a category called " + c.name);
			target->name = name;
			SaveLocked();
			return json{ { "ok", true }, { "act", act }, { "found", true }, { "msg", "Renamed" } }
				.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		if (act == "catDel") {
			const auto cid = j.value("cat", std::string());
			std::lock_guard l(g_m);
			LoadLocked();
			auto it = std::find_if(g_cfg.categories.begin(), g_cfg.categories.end(),
				[&](const Category& c) { return c.id == cid; });
			if (it == g_cfg.categories.end())
				return Refuse(act, "That category no longer exists");
			const auto name = it->name;
			int        refiled = 0;
			for (auto& m : g_cfg.mounts)
				if (m.cat == cid) {
					m.cat.clear();   // refile, never delete the mount
					++refiled;
				}
			g_cfg.categories.erase(it);
			SaveLocked();
			logger::info("mounts: category '{}' deleted, {} mount(s) refiled", name, refiled);
			return json{ { "ok", true }, { "act", act }, { "found", true },
				{ "msg", refiled ? (name + " removed - " + std::to_string(refiled) +
				                       " mount(s) moved to Uncategorised")
				                 : (name + " removed") } }
				.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		if (act == "catReorder") {
			// The view sends the full ordered id list; we reorder to match,
			// dropping unknown ids and appending any we hold that it omitted.
			const auto order = j.value("order", json::array());
			std::lock_guard l(g_m);
			LoadLocked();
			std::vector<Category> next;
			next.reserve(g_cfg.categories.size());
			std::unordered_set<std::string> placed;
			if (order.is_array())
				for (const auto& idv : order) {
					const auto cid = idv.is_string() ? idv.get<std::string>() : std::string();
					if (cid.empty() || placed.count(cid))
						continue;
					for (auto& c : g_cfg.categories)
						if (c.id == cid) {
							next.push_back(c);
							placed.insert(cid);
							break;
						}
				}
			for (auto& c : g_cfg.categories)
				if (!placed.count(c.id))
					next.push_back(c);
			g_cfg.categories = std::move(next);
			SaveLocked();
			return json{ { "ok", true }, { "act", act }, { "found", true }, { "msg", "" } }
				.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		if (act == "setPref") {
			// One free-form view preference (the picker sort today). Touches no
			// mount; stores whatever JSON-scalar value the view sends under `key`
			// and saves. A missing/blank key is a silent no-op — a pref write
			// should never surface an error toast over the picker.
			const auto key = j.value("key", std::string());
			if (key.empty() || key.size() > 40)
				return json{ { "ok", true }, { "act", act }, { "found", true }, { "msg", "" } }
					.dump(-1, ' ', false, json::error_handler_t::replace);
			std::lock_guard l(g_m);
			LoadLocked();
			if (!g_cfg.prefs.is_object())
				g_cfg.prefs = json::object();
			// value may be any JSON scalar (string here); default to a string.
			g_cfg.prefs[key] = j.contains("value") ? j["value"] : json("");
			SaveLocked();
			return json{ { "ok", true }, { "act", act }, { "found", true }, { "msg", "" } }
				.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		if (act == "spin") {
			Mount copy;
			{
				std::lock_guard l(g_m);
				LoadLocked();
				auto* m = FindLocked(id);
				if (!m)
					return Refuse(act, "That mount is no longer in the stable");
				copy = *m;
			}
			auto*      npc = NpcOf(copy);
			const auto nif = BodyNifOf(npc);
			if (nif.empty())
				return Refuse(act, "No body mesh resolves for this mount, so no turntable");
			ItemIcons::CaptureBodyAngles(copy.npId, copy.npPlugin, nif);
			return json{ { "ok", true }, { "act", act }, { "found", true }, { "msg", "" } }
				.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		if (act == "summon" || act == "call" || act == "ride" || act == "goto") {
			Mount copy;
			{
				std::lock_guard l(g_m);
				LoadLocked();
				auto* m = FindLocked(id);
				if (!m)
					return Refuse(act, "That mount is no longer in the stable");
				copy = *m;
			}
			if (copy.kind == "spell") {
				if (act == "call" || act == "goto")
					return Refuse(act, "A summoned mount has nowhere to be until you cast it - use Summon");
				auto* spell = SpellOf(copy);
				if (!spell)
					return Refuse(act, "The summoning spell no longer resolves in this load order");
				auto* player = RE::PlayerCharacter::GetSingleton();
				if (!player || !player->HasSpell(spell))
					return Refuse(act, "You do not know " + std::string(spell->GetName()) + " yet");
			} else {
				if (act == "summon")
					return Refuse(act, "This one is flesh and blood - use Call");
				auto* a = FindActorFor(copy);
				if (!a)
					return Refuse(act,
						copy.name + " is nowhere the game can reach right now - ride out of this cell and try again");
				if (a->IsDead())
					return Refuse(act, copy.name + " is dead");
			}
			// Physical from here: the caller closes the palette and hands the
			// same request to ExecuteAction (the NpcFinder goto/bring shape).
			return json{ { "ok", true }, { "act", act }, { "found", true }, { "msg", "" } }
				.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		return Refuse(act, "Unknown action");
	}

	std::string ExecuteAction(const std::string& req)
	{
		const auto j = json::parse(req, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return "";
		const auto act = j.value("act", std::string());
		const auto id  = j.value("id", std::string());
		Mount      copy;
		{
			std::lock_guard l(g_m);
			LoadLocked();
			auto* m = FindLocked(id);
			if (!m)
				return "";
			copy = *m;
		}
		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player)
			return "";

		if (copy.kind == "spell" && (act == "summon" || act == "ride")) {
			auto* spell = SpellOf(copy);
			if (!spell)
				return "The summoning spell no longer resolves";
			SpellActions::Cast(copy.spPlugin, ActorIdentity::ParseHex(copy.spId), spell->GetFormID());
			if (act == "ride" && !copy.npId.empty()) {
				// Cast lands, creature appears, we mount it - the auto-detect
				// paying off. ~7s of quarter-second beats is generous for any
				// summon VFX; the watcher stops the moment you are on.
				StartMountWatch(copy, 28);
				return "";
			}
			if (act == "ride")
				return "✨ Cast - its record hides what it conjures, so mount it yourself when it appears";
			return "";
		}

		auto* a = FindActorFor(copy);
		if (!a)
			return copy.name + " is nowhere the game can reach right now";

		if (act == "goto") {
			player->MoveTo(a);
			return "You ride to " + copy.name;
		}
		// call / ride: bring the mount to you (skip the teleport when it is
		// already standing beside you - a horse that blinks is a broken horse).
		const bool here = a->Is3DLoaded() &&
		                  a->GetPosition().GetDistance(player->GetPosition()) < 700.0f;
		if (!here)
			a->MoveTo(player);
		if (act == "ride") {
			if (here) {
				ActivateMount(a);
			} else {
				// Post-teleport the 3D needs a beat; the watcher handles it.
				StartMountWatch(copy, 12);
			}
			return "";
		}
		return "🐴 " + copy.name + " comes to you";
	}

	void EnsureRenders()
	{
		if (!ItemIcons::Available())
			return;
		json items = json::array();
		{
			std::lock_guard l(g_m);
			LoadLocked();
			for (const auto& m : g_cfg.mounts) {
				if (m.npId.empty())
					continue;
				auto*      npc = NpcOf(m);
				const auto nif = BodyNifOf(npc);
				if (nif.empty())
					continue;
				items.push_back(json{ { "formId", m.npId }, { "plugin", m.npPlugin },
					{ "name", m.name }, { "nif", nif } });
			}
		}
		if (!items.empty())
			ItemIcons::EnsureBodyIcons(
				json{ { "items", std::move(items) } }.dump(-1, ' ', false, json::error_handler_t::replace));
	}
}
