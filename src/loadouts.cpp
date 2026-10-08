#include "loadouts.h"

#include "actor_identity.h"
#include "follower_deck.h"
#include "follower_frameworks.h"
#include "nff_control.h"
#include "npc_actions.h"
#include "npc_finder.h"
#include "wardrobe.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <thread>
#include <vector>

// windows.h defines GetObject as a macro (GetObjectA/W); BSScript::Variable::GetObject()
// is then mangled at the call site - the same trap every TU reading Papyrus properties hits.
#undef GetObject

namespace Loadouts
{
	namespace
	{
		using json = nlohmann::json;
		using namespace std::literals;

		// ----------------------------------------------------------- model --

		struct StyleRef
		{
			std::string plugin, formId, name;
			int         nff = -1;   // index into NFF's nwsFFcombatStyles, -1 = a plain load-order style
			bool        set() const { return !plugin.empty() && !formId.empty(); }
		};

		struct GearRef
		{
			std::string plugin, formId, name, kind;
			int         count = 1;
		};

		struct Class
		{
			std::string          id, name, note, icon;
			bool                 replace = false;   // strip her worn armour before dressing
			StyleRef             style;
			std::vector<GearRef> gear;
		};

		struct Member
		{
			std::string formId, plugin, name, original, cls;
		};

		struct Loadout
		{
			std::string         id, name, note, icon;
			std::vector<Member> members;
		};

		struct Config
		{
			std::vector<Class>   classes;
			std::vector<Loadout> loadouts;
			std::uint64_t        counter = 1;
			// The group a bound key commands. Persisted, because a keybind that
			// forgot its target across a restart would be worse than no keybind.
			std::string          activeId;
			// key -> the combat style this module last set on that actor, so a
			// load can put it back (NFF only restores ITS twelve).
			std::map<std::string, StyleRef> applied;
		};

		std::mutex g_m;   // file-backed state only
		Config     g_cfg;
		bool       g_loaded = false;

		// NFF's own twelve, in nwsFFcombatStyles order — the MCM's $FF_CombatStyle1..12.
		constexpr const char* kNffStyleNames[12] = {
			"Mercenary", "Defender", "Berserker", "Archer", "Ranger", "Spellsword",
			"Wizard", "Magician", "Priest", "Balanced", "Arcane Archer", "War Priest"
		};

		constexpr RE::FormID kCurrentFollowerFac = 0x0005C84E;

		// ----------------------------------------------------------- small --

		std::string Dump(const json& j)
		{
			return j.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		std::string Trim(std::string s)
		{
			const auto notSpace = [](unsigned char c) { return !std::isspace(c); };
			s.erase(s.begin(), std::find_if(s.begin(), s.end(), notSpace));
			s.erase(std::find_if(s.rbegin(), s.rend(), notSpace).base(), s.end());
			return s;
		}

		std::string Cap(std::string s, std::size_t n)
		{
			if (s.size() > n)
				s.resize(n);
			return s;
		}

		std::string Lower(std::string s)
		{
			std::transform(s.begin(), s.end(), s.begin(),
				[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			return s;
		}

		std::filesystem::path FilePath()
		{
			return std::filesystem::path("Data") / "SKSE" / "Plugins" / "HotkeyDeck" / "loadouts.json";
		}

		std::string NameOf(RE::TESForm* f)
		{
			if (!f)
				return "";
			if (auto* a = f->As<RE::Actor>())
				if (const char* n = a->GetDisplayFullName(); n && *n)
					return n;
			if (const char* n = f->GetName(); n && *n)
				return n;
			return "";
		}

		std::string KeyOf(const std::string& formId, const std::string& plugin)
		{
			return ActorIdentity::Key(formId, plugin);
		}

		// The durable pair for a live form, falling back to the runtime id (a
		// dynamic form has nothing better and is still addressable this session).
		void IdentityOf(RE::TESForm* f, std::string& fid, std::string& plugin)
		{
			fid.clear();
			plugin.clear();
			if (!f)
				return;
			if (ActorIdentity::DurableOf(f, fid, plugin))
				return;
			fid = ActorIdentity::HexOf(f->GetFormID());
			plugin.clear();
		}

		std::string KeyOfForm(RE::TESForm* f)
		{
			std::string fid, plugin;
			IdentityOf(f, fid, plugin);
			return fid.empty() ? std::string() : KeyOf(fid, plugin);
		}

		std::string KindOf(RE::TESForm* f)
		{
			if (!f)
				return "other";
			switch (f->GetFormType()) {
			case RE::FormType::Armor:      return "armor";
			case RE::FormType::Weapon:     return "weapon";
			case RE::FormType::Ammo:       return "ammo";
			case RE::FormType::Light:      return "light";
			case RE::FormType::AlchemyItem: return "potion";
			default:                       return "other";
			}
		}

		bool IsFollowing(RE::Actor* a)
		{
			if (!a)
				return false;
			if (a->IsPlayerTeammate())
				return true;
			if (auto* fac = RE::TESForm::LookupByID<RE::TESFaction>(kCurrentFollowerFac))
				return a->IsInFaction(fac) && a->GetFactionRank(fac, false) >= 0;
			return false;
		}

		// "Plugin.esp|00013989", spelled exactly as the NPC Finder's `fc`.
		std::string FaceIdOf(RE::Actor* a)
		{
			auto* npc = a ? a->GetActorBase() : nullptr;
			if (!npc)
				return {};
			auto* owner = NpcFinder::FaceOwnerOf(npc);
			if (!owner)
				return {};
			auto* file = owner->GetFile(0);
			if (!file)
				return {};
			const std::uint32_t local = owner->GetFormID() & (file->IsLight() ? 0xFFFu : 0xFFFFFFu);
			char buf[16];
			std::snprintf(buf, sizeof(buf), "%08X", local);
			return std::string(file->GetFilename()) + "|" + buf;
		}

		// ------------------------------------------------------ NFF context --
		// The same read-only property binding nff_outfits.cpp uses (a private
		// copy, for the same reason it keeps one): bind nwsFollowerVariableScript
		// on its quest, read two `Auto` properties. No Papyrus FUNCTION is called.

		constexpr const char* kVarScript = "nwsFollowerVariableScript";
		RE::TESQuest* g_varQuest  = nullptr;
		bool          g_varScanned = false;

		RE::BSTSmartPointer<RE::BSScript::Object> BindScript(RE::TESForm* form, const char* cls)
		{
			RE::BSTSmartPointer<RE::BSScript::Object> obj;
			auto* vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			if (!form || !cls || !vm)
				return obj;
			auto* policy = vm->GetObjectHandlePolicy();
			if (!policy)
				return obj;
			const auto handle = policy->GetHandleForObject(form->GetFormType(), form);
			if (handle == policy->EmptyHandle())
				return obj;
			if (vm->FindBoundObject(handle, cls, obj) && obj)
				return obj;
			obj.reset();
			const auto lower = Lower(cls);
			if (lower != cls && vm->FindBoundObject(handle, lower.c_str(), obj) && obj)
				return obj;
			obj.reset();
			return obj;
		}

		const RE::BSScript::Variable* Prop(RE::BSScript::Object* obj, const char* name)
		{
			if (!obj || !name)
				return nullptr;
			if (const auto* v = obj->GetProperty(name))
				return v;
			const std::string backing = "::"s + name + "_var";
			return obj->GetVariable(backing);
		}

		RE::TESForm* VarForm(const RE::BSScript::Variable* v, RE::FormType type)
		{
			if (!v || !v->IsObject() || v->IsNoneObject())
				return nullptr;
			auto obj = v->GetObject();
			if (!obj)
				return nullptr;
			auto* vm     = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			auto* policy = vm ? vm->GetObjectHandlePolicy() : nullptr;
			if (!policy)
				return nullptr;
			const auto handle = obj->GetHandle();
			if (handle == policy->EmptyHandle() || !policy->HandleIsType(type, handle))
				return nullptr;
			return policy->GetObjectForHandle(type, handle);
		}

		RE::BSTSmartPointer<RE::BSScript::Object> VarScript()
		{
			if (!g_varScanned) {
				g_varScanned = true;
				if (auto* dh = RE::TESDataHandler::GetSingleton()) {
					for (auto* q : dh->GetFormArray<RE::TESQuest>()) {
						if (q && BindScript(q, kVarScript)) {
							g_varQuest = q;
							break;
						}
					}
				}
				logger::info("loadouts: NFF variable quest {}",
					g_varQuest ? "bound" : "not found (NFF absent or no save yet)");
			}
			if (!g_varQuest)
				return {};
			return BindScript(g_varQuest, kVarScript);
		}

		// Re-allow the sweep once a save is in (before that, binding fails).
		void ResetNffScan()
		{
			if (!g_varQuest)
				g_varScanned = false;
		}

		RE::TESFaction* NffCsFaction()
		{
			auto obj = VarScript();
			if (!obj)
				return nullptr;
			auto* f = VarForm(Prop(obj.get(), "nwsFF_CSFac"), RE::FormType::Faction);
			return f ? f->As<RE::TESFaction>() : nullptr;
		}

		RE::BGSListForm* NffStyleList()
		{
			auto obj = VarScript();
			if (!obj)
				return nullptr;
			auto* f = VarForm(Prop(obj.get(), "nwsFFcombatStyles"), RE::FormType::FormList);
			return f ? f->As<RE::BGSListForm>() : nullptr;
		}

		// ------------------------------------------------------- persistence --

		json StyleJson(const StyleRef& s)
		{
			if (!s.set())
				return nullptr;
			return json{ { "plugin", s.plugin }, { "formId", s.formId }, { "name", s.name }, { "nff", s.nff } };
		}

		StyleRef StyleFrom(const json& j)
		{
			StyleRef s;
			if (!j.is_object())
				return s;
			s.plugin = j.value("plugin", std::string());
			s.formId = j.value("formId", std::string());
			s.name   = j.value("name", std::string());
			s.nff    = j.value("nff", -1);
			return s;
		}

		json ClassJson(const Class& c)
		{
			auto gear = json::array();
			for (const auto& g : c.gear)
				gear.push_back(json{ { "plugin", g.plugin }, { "formId", g.formId }, { "name", g.name },
					{ "kind", g.kind }, { "count", g.count } });
			return json{ { "id", c.id }, { "name", c.name }, { "note", c.note }, { "icon", c.icon },
				{ "replace", c.replace }, { "style", StyleJson(c.style) }, { "gear", gear } };
		}

		json LoadoutJson(const Loadout& l)
		{
			auto mem = json::array();
			for (const auto& m : l.members)
				mem.push_back(json{ { "formId", m.formId }, { "plugin", m.plugin }, { "name", m.name },
					{ "original", m.original }, { "cls", m.cls }, { "key", KeyOf(m.formId, m.plugin) } });
			return json{ { "id", l.id }, { "name", l.name }, { "note", l.note }, { "icon", l.icon }, { "members", mem } };
		}

		bool ClassExistsLocked(const std::string& id)
		{
			if (id.empty())
				return true;
			for (const auto& c : g_cfg.classes)
				if (c.id == id)
					return true;
			return false;
		}

		void LoadLocked()
		{
			if (g_loaded)
				return;
			g_loaded = true;
			std::ifstream in(FilePath(), std::ios::binary);
			if (!in.is_open()) {
				logger::info("loadouts: no loadouts.json yet - starting empty");
				return;
			}
			auto j = json::parse(in, nullptr, false);
			if (j.is_discarded() || !j.is_object()) {
				logger::warn("loadouts: loadouts.json did not parse - starting empty (file kept on disk)");
				return;
			}
			g_cfg.counter  = j.value("counter", std::uint64_t{ 1 });
			g_cfg.activeId = j.value("active", std::string());
			if (j.contains("classes") && j["classes"].is_array()) {
				for (const auto& e : j["classes"]) {
					if (!e.is_object())
						continue;
					Class c;
					c.id      = e.value("id", std::string());
					c.name    = e.value("name", std::string());
					c.note    = e.value("note", std::string());
					c.icon    = e.value("icon", std::string());
					c.replace = e.value("replace", false);
					if (e.contains("style"))
						c.style = StyleFrom(e["style"]);
					if (e.contains("gear") && e["gear"].is_array()) {
						for (const auto& g : e["gear"]) {
							if (!g.is_object())
								continue;
							GearRef r;
							r.plugin = g.value("plugin", std::string());
							r.formId = g.value("formId", std::string());
							r.name   = g.value("name", std::string());
							r.kind   = g.value("kind", std::string("other"));
							r.count  = std::clamp(g.value("count", 1), 1, 999);
							if (!r.plugin.empty() && !r.formId.empty())
								c.gear.push_back(std::move(r));
						}
					}
					if (c.id.empty() || c.name.empty() || ClassExistsLocked(c.id))
						continue;
					g_cfg.classes.push_back(std::move(c));
				}
			}
			if (j.contains("loadouts") && j["loadouts"].is_array()) {
				for (const auto& e : j["loadouts"]) {
					if (!e.is_object())
						continue;
					Loadout l;
					l.id   = e.value("id", std::string());
					l.name = e.value("name", std::string());
					l.note = e.value("note", std::string());
					l.icon = e.value("icon", std::string());
					if (e.contains("members") && e["members"].is_array()) {
						for (const auto& m : e["members"]) {
							if (!m.is_object())
								continue;
							Member r;
							r.formId   = m.value("formId", std::string());
							r.plugin   = m.value("plugin", std::string());
							r.name     = m.value("name", std::string());
							r.original = m.value("original", std::string());
							r.cls      = m.value("cls", std::string());
							if (r.formId.empty())
								continue;
							if (!ClassExistsLocked(r.cls))
								r.cls.clear();
							l.members.push_back(std::move(r));
						}
					}
					if (l.id.empty() || l.name.empty())
						continue;
					g_cfg.loadouts.push_back(std::move(l));
				}
			}
			if (j.contains("applied") && j["applied"].is_object()) {
				for (auto it = j["applied"].begin(); it != j["applied"].end(); ++it) {
					auto s = StyleFrom(it.value());
					if (s.set())
						g_cfg.applied[it.key()] = s;
				}
			}
			logger::info("loadouts: loaded {} loadout(s), {} class(es), {} remembered style(s)",
				g_cfg.loadouts.size(), g_cfg.classes.size(), g_cfg.applied.size());
		}

		void SaveLocked()
		{
			json j;
			j["version"] = 1;
			j["counter"] = g_cfg.counter;
			j["active"]  = g_cfg.activeId;
			auto cls = json::array();
			for (const auto& c : g_cfg.classes)
				cls.push_back(ClassJson(c));
			j["classes"] = cls;
			auto los = json::array();
			for (const auto& l : g_cfg.loadouts)
				los.push_back(LoadoutJson(l));
			j["loadouts"] = los;
			auto ap = json::object();
			for (const auto& [k, s] : g_cfg.applied)
				ap[k] = StyleJson(s);
			j["applied"] = ap;

			std::string text;
			try {
				text = j.dump(2, ' ', false, json::error_handler_t::replace);
			} catch (...) {
				logger::error("loadouts: serialise failed - loadouts.json NOT written");
				return;
			}
			const auto      path = FilePath();
			std::error_code ec;
			std::filesystem::create_directories(path.parent_path(), ec);
			if (std::filesystem::exists(path, ec)) {
				auto bak = path;
				bak.replace_extension(".bak");
				std::filesystem::copy_file(path, bak, std::filesystem::copy_options::overwrite_existing, ec);
			}
			auto tmp = path;
			tmp += ".tmp";
			{
				std::ofstream out(tmp, std::ios::binary | std::ios::trunc);
				if (!out.is_open()) {
					logger::error("loadouts: could not open loadouts.json.tmp for write");
					return;
				}
				out << text;
			}
			std::filesystem::rename(tmp, path, ec);
			if (ec) {
				std::filesystem::copy_file(tmp, path, std::filesystem::copy_options::overwrite_existing, ec);
				std::filesystem::remove(tmp, ec);
			}
		}

		Loadout* FindLoadoutLocked(const std::string& id)
		{
			for (auto& l : g_cfg.loadouts)
				if (l.id == id)
					return &l;
			return nullptr;
		}

		Class* FindClassLocked(const std::string& id)
		{
			for (auto& c : g_cfg.classes)
				if (c.id == id)
					return &c;
			return nullptr;
		}

		Member* FindMemberLocked(Loadout& l, const std::string& formId, const std::string& plugin)
		{
			const auto key = KeyOf(formId, plugin);
			for (auto& m : l.members)
				if (KeyOf(m.formId, m.plugin) == key)
					return &m;
			return nullptr;
		}

		// ------------------------------------------------------------ styles --

		std::vector<StyleRef> StyleCatalogue()
		{
			std::vector<StyleRef> out;
			std::set<std::string>  seen;
			auto push = [&](RE::TESForm* f, const std::string& name, int nff) {
				auto* cs = f ? f->As<RE::TESCombatStyle>() : nullptr;
				if (!cs)
					return;
				StyleRef s;
				IdentityOf(cs, s.plugin, s.formId);
				if (s.formId.empty())
					return;
				const auto key = KeyOf(s.formId, s.plugin);
				if (!seen.insert(key).second)
					return;
				s.nff  = nff;
				s.name = name;
				if (s.name.empty()) {
					if (const char* eid = cs->GetFormEditorID(); eid && *eid)
						s.name = eid;
					else
						s.name = "Style " + s.formId;
				}
				out.push_back(std::move(s));
			};
			if (auto* list = NffStyleList()) {
				int i = 0;
				for (auto* f : list->forms) {
					push(f, i < 12 ? kNffStyleNames[i] : ("NFF style " + std::to_string(i + 1)), i);
					++i;
				}
			}
			std::vector<StyleRef> rest;
			if (auto* dh = RE::TESDataHandler::GetSingleton()) {
				for (auto* cs : dh->GetFormArray<RE::TESCombatStyle>()) {
					const std::size_t before = out.size();
					push(cs, "", -1);
					if (out.size() > before) {
						rest.push_back(out.back());
						out.pop_back();
					}
				}
			}
			std::sort(rest.begin(), rest.end(), [](const StyleRef& a, const StyleRef& b) {
				return Lower(a.name) < Lower(b.name);
			});
			out.insert(out.end(), rest.begin(), rest.end());
			return out;
		}

		// ActorBase.SetCombatStyle, exactly what NFF's SetCombatST does, plus its
		// faction bookkeeping so the two never disagree about who set what.
		bool ApplyStyle(RE::Actor* a, const StyleRef& st, std::string& note)
		{
			auto* form = ActorIdentity::Resolve(st.formId, st.plugin);
			auto* cs   = form ? form->As<RE::TESCombatStyle>() : nullptr;
			if (!cs) {
				note = "combat style " + st.name + " no longer resolves";
				return false;
			}
			auto* base = a ? a->GetActorBase() : nullptr;
			if (!base) {
				note = "no actor base";
				return false;
			}
			base->SetCombatStyle(cs);
			if (auto* fac = NffCsFaction()) {
				if (st.nff >= 0)
					a->AddToFaction(fac, static_cast<std::int8_t>(st.nff));
				else if (a->IsInFaction(fac))
					a->RemoveFromFaction(fac);
			}
			if (!base->IsUnique())
				note = "shares a template - every " + NameOf(a) + " now fights this way";
			return true;
		}

		// -------------------------------------------------------------- gear --

		struct DressResult
		{
			int  given = 0, worn = 0, missing = 0;
			bool styled = false;
			bool refused = false;   // SOES owns her
			std::string note;
		};

		DressResult DressActor(RE::Actor* a, const Class& c, const std::string& fid, const std::string& plugin)
		{
			DressResult r;
			if (!a || a->IsDead())
				return r;
			auto* eqm = RE::ActorEquipManager::GetSingleton();
			const bool soes = Wardrobe::IsTrackedActor(fid, plugin);
			if (!c.gear.empty() && soes) {
				r.refused = true;
				r.note = NameOf(a) + " is dressed by Wardrobe (SOES) - assign her outfit there";
			}
			if (!c.gear.empty() && !soes && eqm) {
				if (c.replace) {
					// Strip worn ARMOUR only; weapons stay unless the class brings its own.
					std::vector<RE::TESBoundObject*> off;
					auto inv = a->GetInventory();
					for (auto& [obj, data] : inv) {
						if (!obj || data.first <= 0)
							continue;
						auto* entry = data.second.get();
						if (!entry || !entry->IsWorn())
							continue;
						if (obj->As<RE::TESObjectARMO>())
							off.push_back(obj);
					}
					for (auto* obj : off)
						eqm->UnequipObject(a, obj);
				}
				for (const auto& g : c.gear) {
					auto* form = ActorIdentity::Resolve(g.formId, g.plugin);
					auto* obj  = form ? form->As<RE::TESBoundObject>() : nullptr;
					if (!obj) {
						++r.missing;
						continue;
					}
					std::int32_t have = 0;
					{
						auto inv = a->GetInventory();
						auto it  = inv.find(obj);
						if (it != inv.end())
							have = it->second.first;
					}
					if (have < g.count) {
						a->AddObjectToContainer(obj, nullptr, g.count - have, nullptr);
						r.given += g.count - have;
					}
					const auto ft = obj->GetFormType();
					if (ft == RE::FormType::Armor || ft == RE::FormType::Weapon ||
						ft == RE::FormType::Ammo || ft == RE::FormType::Light) {
						eqm->EquipObject(a, obj, nullptr, 1, nullptr,
							/*queueEquip*/ true, /*forceEquip*/ true, /*playSounds*/ false, /*applyNow*/ true);
						++r.worn;
					}
				}
			}
			if (c.style.set()) {
				std::string note;
				if (ApplyStyle(a, c.style, note)) {
					r.styled = true;
					std::lock_guard l(g_m);
					g_cfg.applied[KeyOf(fid, plugin)] = c.style;
					SaveLocked();
				}
				if (!note.empty())
					r.note = r.note.empty() ? note : (r.note + "; " + note);
			}
			logger::info("loadouts: dressed {} as {} - {} given, {} worn, {} missing, style {}{}",
				NameOf(a), c.name, r.given, r.worn, r.missing, r.styled ? "set" : "untouched",
				r.refused ? " (SOES-tracked, gear refused)" : "");
			return r;
		}

		// ------------------------------------------------------------- roster --

		json RosterJson(std::vector<std::string>& partyKeys)
		{
			json roster = json::array();
			auto st = json::parse(FollowerDeck::StateJson(), nullptr, false);
			const json* cats = nullptr;
			if (st.is_object()) {
				if (st.contains("categories") && st["categories"].is_array())
					cats = &st["categories"];
				else if (st.contains("state") && st["state"].is_object() &&
						 st["state"].contains("categories") && st["state"]["categories"].is_array())
					cats = &st["state"]["categories"];
			}
			std::set<std::string> seen;
			if (cats) {
				for (const auto& c : *cats) {
					if (!c.is_object() || !c.contains("members") || !c["members"].is_array())
						continue;
					std::string catName = c.value("name", std::string());
					if (catName.empty())
						catName = c.value("original", std::string());
					for (const auto& m : c["members"]) {
						if (!m.is_object())
							continue;
						/* `liveFormId` first. Follower Organizer cannot persist a
						   0xFF reference (no source file to name) and stores the
						   follower's BASE NPC_ record instead — which LookupByID
						   happily returns and As<Actor> then rejects, so a
						   spawned follower never appeared in a loadout AT ALL.
						   FO now sends the reference it found beside it
						   (DeckAPI.cpp, LoadedActorForBase).
						   ⚠ Her key is then a runtime id with no plugin, because
						   a dynamic actor HAS no durable identity — IdentityOf
						   falls back to exactly that. So a saved loadout holding
						   her is good for this session and will simply fail to
						   resolve in the next one, with the "can't be found"
						   message the deploy path already has. That is the honest
						   trade: addressable now beats invisible always. */
						RE::FormID rid = 0;
						for (const char* k : { "liveFormId", "formId" }) {
							if (rid)
								break;
							if (m.contains(k) && m[k].is_string()) {
								try { rid = static_cast<RE::FormID>(std::stoul(m[k].get<std::string>(), nullptr, 16)); }
								catch (...) { rid = 0; }
								if (rid && !RE::TESForm::LookupByID<RE::Actor>(rid))
									rid = 0;   // a base record: keep looking
							}
						}
						auto* a = rid ? RE::TESForm::LookupByID<RE::Actor>(rid) : nullptr;
						if (!a)
							continue;   // nothing durable to store; the roster row is a ghost
						std::string fid, plugin;
						IdentityOf(a, fid, plugin);
						if (fid.empty())
							continue;
						const auto key = KeyOf(fid, plugin);
						if (!seen.insert(key).second)
							continue;
						auto* base = a->GetActorBase();
						roster.push_back(json{
							{ "formId", fid }, { "plugin", plugin }, { "key", key },
							{ "name", m.value("name", NameOf(a)) },
							{ "original", m.value("original", std::string()) },
							{ "cat", catName },
							{ "fc", FaceIdOf(a) },
							{ "following", IsFollowing(a) },
							{ "inWorld", m.value("inWorld", true) },
							{ "dead", a->IsDead() },
							{ "guarded", FollowerFrameworks::OwningCompanionSpec(a) >= 0 },
							{ "unique", base ? base->IsUnique() : true } });
					}
				}
			}
			// The party: everyone with you right now, by the same net the HUD and
			// the party sheet cast (teammate flag OR the follower faction).
			partyKeys.clear();
			if (auto* lists = RE::ProcessLists::GetSingleton()) {
				auto* player = RE::PlayerCharacter::GetSingleton();
				std::set<RE::FormID> seenIds;
				for (auto& h : lists->highActorHandles) {
					auto       ptr = h.get();
					RE::Actor* a   = ptr ? ptr.get() : nullptr;
					if (!a || a == player || a->IsPlayerRef() || a->IsDead())
						continue;
					if (!seenIds.insert(a->GetFormID()).second)
						continue;
					if (!IsFollowing(a))
						continue;
					const auto key = KeyOfForm(a);
					if (!key.empty())
						partyKeys.push_back(key);
					// Someone following who is not on the FO roster still needs a
					// row, or "add everyone with me" would silently skip her.
					if (!seen.count(key)) {
						seen.insert(key);
						std::string fid, plugin;
						IdentityOf(a, fid, plugin);
						auto* base = a->GetActorBase();
						roster.push_back(json{
							{ "formId", fid }, { "plugin", plugin }, { "key", key },
							{ "name", NameOf(a) }, { "original", std::string() },
							{ "cat", std::string() }, { "fc", FaceIdOf(a) },
							{ "following", true }, { "inWorld", true }, { "dead", false },
							{ "guarded", FollowerFrameworks::OwningCompanionSpec(a) >= 0 },
							{ "unique", base ? base->IsUnique() : true } });
					}
				}
			}
			return roster;
		}

		// ---------------------------------------------------------- the job --

		struct Job
		{
			std::string          act, mode, loName, clsFilter;
			std::vector<Member>  members;
			std::vector<Member>  toDismiss;      // swap: current followers outside the group
			std::size_t          i = 0;
			int                  phase = 0;      // 0 dismiss · 1 bring/recruit · 2 dress · 3 done
			int                  brought = 0, recruited = 0, dismissed = 0, dressed = 0, styled = 0, refused = 0;
			std::vector<std::string> notes;
			std::uint64_t        seq = 0;
		};

		std::shared_ptr<Job> g_job;

		// The one-line result of the last order that ran, so a pane opened after
		// the notification faded can still say what happened. Lives beside g_job
		// (in-memory, per session) - it is a report, not saved state.
		// What the deck last TOLD the party to do about sandboxing. NFF exposes
		// nwsAllowSandbox (may they relax at all) but nothing that reads "are
		// they relaxing right now", so this is the deck's memory, not engine
		// truth — it is reset on a load, where the safe default is "not
		// relaxing" (pressing Relax when they already are is a no-op anyway).
		std::atomic<bool> g_partyRelaxed{ false };

		std::mutex   g_lastM;
		std::string  g_lastSummary;
		std::int64_t g_lastSummaryAt = 0;   // epoch seconds

		void Step(std::shared_ptr<Job> job);

		std::string LastSummary()
		{
			std::lock_guard l(g_lastM);
			return g_lastSummary;
		}

		std::int64_t LastSummaryAt()
		{
			std::lock_guard l(g_lastM);
			return g_lastSummaryAt;
		}

		// Resume the chain after `delayMs`, exactly once per step token: the NFF
		// `done` callback and the 3 s timeout both call this with the same `s`,
		// and whichever lands first wins.
		void Continue(std::shared_ptr<Job> job, std::uint64_t s, int delayMs)
		{
			std::thread([job, s, delayMs]() {
				if (delayMs > 0)
					std::this_thread::sleep_for(std::chrono::milliseconds(delayMs));
				SKSE::GetTaskInterface()->AddTask([job, s]() {
					if (!job || job != g_job || job->seq != s)
						return;
					++job->seq;
					Step(job);
				});
			}).detach();
		}

		void Note(Job& j, const std::string& s)
		{
			if (!s.empty() && j.notes.size() < 12)
				j.notes.push_back(s);
		}

		// One NFF op on one member; returns true when the chain must WAIT for done.
		bool NffOp(std::shared_ptr<Job> job, const char* op, const Member& m, int& counter)
		{
			const auto  s   = job->seq;
			const json  cmd{ { "op", op }, { "formId", m.formId }, { "plugin", m.plugin }, { "name", m.name } };
			const auto  pre = NffControl::Apply(Dump(cmd), [job, s, &counter, op](const std::string& res) {
				auto jr = json::parse(res, nullptr, false);
				if (!jr.is_discarded() && jr.value("ok", false))
					++counter;
				else if (!jr.is_discarded())
					Note(*job, jr.value("msg", std::string(op) + " failed"));
				Continue(job, s, 450);
			});
			auto jp = json::parse(pre, nullptr, false);
			if (jp.is_discarded() || !jp.value("ok", false)) {
				const auto msg = jp.is_discarded() ? std::string() : jp.value("msg", std::string());
				// "already following" is not a failure for a deploy.
				if (!(jp.is_object() && jp.value("following", false) && std::string(op) == "recruit"))
					Note(*job, msg);
				return false;
			}
			if (jp.value("phase", std::string()) == "done") {
				++counter;
				return false;
			}
			// Sent: wait for done, or give up after 3 s (the VM may never run it).
			Continue(job, s, 3000);
			return true;
		}

		bool BringToPlayer(RE::Actor* a, RE::PlayerCharacter* player)
		{
			if (!a || !player || a->IsDead())
				return false;
			if (a->IsDisabled())
				a->Enable(false);
			const bool sameCell = a->GetParentCell() && a->GetParentCell() == player->GetParentCell();
			const float dist    = a->GetPosition().GetDistance(player->GetPosition());
			if (sameCell && dist < 700.0f && !a->IsDisabled())
				return false;   // already at your side - no pop
			a->MoveTo(player);
			a->EvaluatePackage();
			return true;
		}

		void Finish(std::shared_ptr<Job> job)
		{
			std::string msg = job->loName + ": ";
			std::vector<std::string> bits;
			if (job->act == "deploy" || job->act == "summon")
				bits.push_back(std::to_string(job->brought) + " brought");
			if (job->act == "deploy")
				bits.push_back(std::to_string(job->recruited) + " recruited");
			if (job->act == "deploy" && job->mode == "swap")
				bits.push_back(std::to_string(job->dismissed) + " dismissed");
			if (job->act == "dismiss")
				bits.push_back(std::to_string(job->dismissed) + " dismissed");
			if (job->act == "deploy" || job->act == "dress" || job->act == "dressOne" || job->act == "dressClass") {
				bits.push_back(std::to_string(job->dressed) + " dressed");
				if (job->styled)
					bits.push_back(std::to_string(job->styled) + " restyled");
			}
			if (job->refused)
				bits.push_back(std::to_string(job->refused) + " refused");
			for (std::size_t k = 0; k < bits.size(); ++k)
				msg += (k ? ", " : "") + bits[k];
			if (!job->notes.empty())
				msg += " - " + job->notes.front();
			{
				std::lock_guard l(g_lastM);
				g_lastSummary   = msg;
				g_lastSummaryAt = static_cast<std::int64_t>(
					std::chrono::duration_cast<std::chrono::seconds>(
						std::chrono::system_clock::now().time_since_epoch()).count());
			}
			RE::DebugNotification(msg.c_str());
			logger::info("loadouts: {} finished - {}{}", job->act, msg,
				job->notes.size() > 1 ? (" (+" + std::to_string(job->notes.size() - 1) + " more notes in the reply)") : "");
			for (const auto& n : job->notes)
				logger::info("loadouts:   note: {}", n);
			if (g_job == job)
				g_job.reset();
		}

		void Step(std::shared_ptr<Job> job)
		{
			auto* player = RE::PlayerCharacter::GetSingleton();
			if (!player) {
				Finish(job);
				return;
			}
			// phase 0 - swap/dismiss: one NFF dismiss at a time
			if (job->phase == 0) {
				while (job->i < job->toDismiss.size()) {
					const auto& m = job->toDismiss[job->i++];
					auto* a = ActorIdentity::ResolveActor(m.formId, m.plugin);
					if (!a || !IsFollowing(a))
						continue;
					if (NffOp(job, "dismiss", m, job->dismissed))
						return;   // resumes via Continue
				}
				job->phase = 1;
				job->i     = 0;
			}
			// phase 1 - bring + recruit, one at a time
			if (job->phase == 1) {
				const bool recruit = (job->act == "deploy");
				const bool bring   = (job->act == "deploy" || job->act == "summon");
				const bool dismiss = (job->act == "dismiss");
				while ((bring || dismiss) && job->i < job->members.size()) {
					const auto& m = job->members[job->i++];
					auto* a = ActorIdentity::ResolveActor(m.formId, m.plugin);
					if (!a) {
						Note(*job, m.name + " can't be found (plugin missing?)");
						continue;
					}
					if (a->IsDead()) {
						Note(*job, m.name + " is dead");
						continue;
					}
					if (dismiss) {
						if (!IsFollowing(a))
							continue;
						if (NffOp(job, "dismiss", m, job->dismissed))
							return;
						continue;
					}
					if (BringToPlayer(a, player))
						++job->brought;
					if (recruit && !IsFollowing(a)) {
						if (NffOp(job, "recruit", m, job->recruited))
							return;
					}
				}
				job->phase = 2;
				job->i     = 0;
			}
			// phase 2 - dress the loaded members (synchronous engine writes)
			if (job->phase == 2) {
				const bool dress = (job->act == "deploy" || job->act == "dress" ||
				                    job->act == "dressOne" || job->act == "dressClass");
				if (dress) {
					std::vector<Class> classes;
					{
						std::lock_guard l(g_m);
						classes = g_cfg.classes;
					}
					for (const auto& m : job->members) {
						if (m.cls.empty())
							continue;
						if (!job->clsFilter.empty() && m.cls != job->clsFilter)
							continue;
						const Class* c = nullptr;
						for (const auto& k : classes)
							if (k.id == m.cls)
								c = &k;
						if (!c)
							continue;
						auto* a = ActorIdentity::ResolveActor(m.formId, m.plugin);
						if (!a || a->IsDead() || !a->Is3DLoaded())
							continue;
						auto r = DressActor(a, *c, m.formId, m.plugin);
						if (r.refused)
							++job->refused;
						else if (r.worn || r.given)
							++job->dressed;
						if (r.styled)
							++job->styled;
						if (!r.note.empty())
							Note(*job, r.note);
					}
				}
				job->phase = 3;
			}
			Finish(job);
		}

		// ------------------------------------------- instant group orders --
		//
		// Follow / Wait / Sic 'em / Relax do NOT ride the serialised job. The
		// job exists for NFF's recruit and dismiss, which park actActor+doAction
		// on ONE controller script and RegisterForSingleUpdate(0.2) — a second
		// call inside that window overwrites the first. wait/follow are not that
		// shape: they are direct per-actor calls on the controller quest, which
		// is exactly why NffControl's own allWait/allFollow loop them with no
		// gap at all. So these run to completion inline and report at once.
		//
		// The point of doing it here rather than reusing the party actions is
		// SCOPE: these order THIS GROUP, so the escort can hold a doorway while
		// the rest of your people keep walking. NFF's relax is the one exception
		// — its sandbox state is group-wide by design (nwsFollowerSandboxScript
		// walks NFF's own alias array), so there is no per-follower relax to
		// scope and the button says so.

		std::string RunGroupOrder(const std::string& act, const std::string& loName,
			const std::vector<Member>& members)
		{
			if (act == "partyRelax" || act == "partyUnrelax") {
				const bool on = (act == "partyRelax");
				NffControl::Apply(Dump(json{ { "op", on ? "allRelax" : "allUnrelax" } }), nullptr);
				g_partyRelaxed.store(on);
				return on ? "Everyone, at ease" : "Everyone back to you";
			}

			if (act == "groupDisengage") {
				// Break off: clear the fight, put the weapons away, fall back in.
				// StopCombat and DrawWeaponMagicHands are engine natives, so the
				// combat half lands immediately; the follow half is NFF's own
				// order, the same call Follow makes. If the enemy is still alive
				// and still hostile they WILL re-engage — that is correct, this
				// is "disengage", not "make me invincible".
				int broke = 0;
				for (const auto& m : members) {
					auto* a = ActorIdentity::ResolveActor(m.formId, m.plugin);
					if (!a || a->IsDead() || !a->Is3DLoaded())
						continue;
					NpcActions::CancelOrder(a->GetFormID());  // or the standing order sends her straight back
					a->StopCombat();
					a->DrawWeaponMagicHands(false);
					++broke;
					if (IsFollowing(a))
						NffControl::Apply(Dump(json{ { "op", "follow" },
							{ "formId", m.formId }, { "plugin", m.plugin } }), nullptr);
				}
				std::string msg = loName + ": " + std::to_string(broke) + " broke off";
				logger::info("loadouts: group order {} — {} ordered, {} skipped",  // marker: loadouts-group-order
					act, broke, static_cast<int>(members.size()) - broke);
				RE::DebugNotification(msg.c_str());
				return msg;
			}

			if (act == "groupSic") {
				// Only THIS group charges. Identity is the runtime actor's, the
				// same (formId, plugin) pair every other member op resolves by.
				std::set<std::string> keys;
				for (const auto& m : members)
					keys.insert(KeyOf(m.formId, m.plugin));
				// `keys` by VALUE: SicEm keeps this predicate until the bolt lands.
				const bool ok = NpcActions::SicEm([keys](RE::Actor* a) {
					std::string f, p;
					IdentityOf(a, f, p);
					return !f.empty() && keys.count(KeyOf(f, p)) > 0;
				}, loName);
				// SicEm already put its own line on screen either way.
				return ok ? (loName + ": attacking your target") : std::string();
			}

			const bool wait = (act == "groupWait");
			int fired = 0, skipped = 0;
			for (const auto& m : members) {
				auto* a = ActorIdentity::ResolveActor(m.formId, m.plugin);
				if (!a || a->IsDead() || !a->Is3DLoaded()) { ++skipped; continue; }
				if (!IsFollowing(a)) { ++skipped; continue; }   // NFF refuses a non-follower anyway
				const auto res = NffControl::Apply(Dump(json{
					{ "op", wait ? "wait" : "follow" },
					{ "formId", m.formId }, { "plugin", m.plugin } }), nullptr);
				const auto rj = json::parse(res, nullptr, false);
				if (!rj.is_discarded() && rj.value("ok", false)) ++fired; else ++skipped;
			}
			std::string msg = loName + ": " + std::to_string(fired) +
				(wait ? " told to wait here" : " following again");
			if (skipped)
				msg += ", " + std::to_string(skipped) + " not with you";
			logger::info("loadouts: group order {} — {} ordered, {} skipped",  // marker: loadouts-group-order
				act, fired, skipped);
			RE::DebugNotification(msg.c_str());
			return msg;
		}

		// -------------------------------------------------------- act helpers --

		std::string Ok(const std::string& act, const std::string& msg, const std::string& id = {})
		{
			json j{ { "ok", true }, { "act", act }, { "msg", msg } };
			if (!id.empty())
				j["id"] = id;
			return Dump(j);
		}

		std::string Fail(const std::string& act, const std::string& msg)
		{
			logger::warn("loadouts: {} refused - {}", act, msg);
			return Dump(json{ { "ok", false }, { "act", act }, { "msg", msg } });
		}

		std::string NewId(const char* prefix)
		{
			return std::string(prefix) + std::to_string(g_cfg.counter++);
		}
	}

	// ============================================================== public ==

	bool IsPhysical(const std::string& act)
	{
		return act == "deploy" || act == "summon" || act == "dismiss" || act == "dress" ||
		       act == "dressOne" || act == "dressClass" ||
		       act == "groupFollow" || act == "groupWait" || act == "groupSic" ||
		       act == "groupDisengage" || act == "partyRelax" || act == "partyUnrelax";
	}

	std::string StateJson()
	{
		ResetNffScan();
		std::vector<std::string> party;
		json roster = RosterJson(party);
		json styles = json::array();
		for (const auto& s : StyleCatalogue())
			styles.push_back(StyleJson(s));

		std::lock_guard l(g_m);
		LoadLocked();
		json los = json::array();
		for (const auto& lo : g_cfg.loadouts)
			los.push_back(LoadoutJson(lo));
		json cls = json::array();
		for (const auto& c : g_cfg.classes)
			cls.push_back(ClassJson(c));
		return Dump(json{
			{ "ok", true },
			{ "ready", RE::PlayerCharacter::GetSingleton() != nullptr },
			{ "nff", NffControl::Available() },
			{ "busy", g_job != nullptr },
			{ "loadouts", los }, { "classes", cls },
			{ "roster", roster }, { "party", party }, { "styles", styles },
			{ "last", LastSummary() }, { "lastAt", LastSummaryAt() },
			{ "active", g_cfg.activeId }, { "relaxed", g_partyRelaxed.load() } });
	}

	std::string ActJson(const std::string& req)
	{
		auto j = json::parse(req, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return Fail("?", "Bad request");
		const auto act = j.value("act", std::string());
		const auto id  = j.value("id", std::string());
		auto str = [&](const char* k, std::size_t cap = 200) { return Cap(Trim(j.value(k, std::string())), cap); };

		std::lock_guard l(g_m);
		LoadLocked();

		// ---- loadouts ----
		if (act == "loNew") {
			const auto name = str("name", 60);
			if (name.empty())
				return Fail(act, "Give the loadout a name");
			Loadout lo;
			lo.id   = NewId("l");
			lo.name = name;
			lo.icon = str("icon", 8);
			g_cfg.loadouts.push_back(lo);
			SaveLocked();
			return Ok(act, "Loadout \"" + name + "\" created", lo.id);
		}
		if (act == "loPin") {
			// ★ the group a bound key commands. Pinning the pinned one clears it.
			auto* lo = FindLoadoutLocked(id);
			if (!lo)
				return Fail(act, "That loadout no longer exists");
			g_cfg.activeId = (g_cfg.activeId == id) ? std::string() : id;
			SaveLocked();
			return Ok(act, g_cfg.activeId.empty() ? (lo->name + " is no longer the keyed group")
												  : (lo->name + " is now the keyed group"), id);
		}
		if (act == "loRename" || act == "loNote" || act == "loIcon" || act == "loDelete" ||
			act == "loAdd" || act == "loRemove" || act == "loSetClass" || act == "loAddParty" ||
			act == "loReorder" || act == "loMove") {
			auto* lo = FindLoadoutLocked(id);
			if (!lo)
				return Fail(act, "That loadout no longer exists");
			if (act == "loRename") {
				const auto name = str("name", 60);
				if (name.empty())
					return Fail(act, "A loadout needs a name");
				lo->name = name;
				SaveLocked();
				return Ok(act, "Renamed", id);
			}
			if (act == "loNote") { lo->note = str("note", 400); SaveLocked(); return Ok(act, "Note saved", id); }
			if (act == "loIcon") { lo->icon = str("icon", 8); SaveLocked(); return Ok(act, "Icon set", id); }
			if (act == "loDelete") {
				const auto name = lo->name;
				g_cfg.loadouts.erase(std::remove_if(g_cfg.loadouts.begin(), g_cfg.loadouts.end(),
					[&](const Loadout& x) { return x.id == id; }), g_cfg.loadouts.end());
				if (g_cfg.activeId == id)
					g_cfg.activeId.clear();   // a key must never point at a deleted group
				SaveLocked();
				return Ok(act, "Loadout \"" + name + "\" deleted");
			}
			if (act == "loReorder") {
				// ids: the full new order
				if (!j.contains("ids") || !j["ids"].is_array())
					return Fail(act, "Bad order");
				std::vector<Loadout> next;
				for (const auto& e : j["ids"])
					if (e.is_string())
						if (auto* x = FindLoadoutLocked(e.get<std::string>()))
							next.push_back(*x);
				for (const auto& x : g_cfg.loadouts)
					if (std::none_of(next.begin(), next.end(), [&](const Loadout& n) { return n.id == x.id; }))
						next.push_back(x);
				g_cfg.loadouts = std::move(next);
				SaveLocked();
				return Ok(act, "Reordered");
			}
			if (act == "loAdd") {
				const auto fid    = str("formId", 24);
				const auto plugin = str("plugin", 120);
				if (fid.empty())
					return Fail(act, "No one to add");
				if (FindMemberLocked(*lo, fid, plugin))
					return Fail(act, str("name", 80) + " is already in " + lo->name);
				Member m;
				m.formId   = fid;
				m.plugin   = plugin;
				m.name     = str("name", 80);
				m.original = str("original", 80);
				m.cls      = str("cls", 24);
				if (!ClassExistsLocked(m.cls))
					m.cls.clear();
				if (m.name.empty())
					m.name = NameOf(ActorIdentity::ResolveActor(fid, plugin));
				lo->members.push_back(m);
				SaveLocked();
				return Ok(act, m.name + " joined " + lo->name, id);
			}
			if (act == "loAddParty") {
				std::vector<std::string> party;
				json roster = RosterJson(party);
				int added = 0;
				for (const auto& r : roster) {
					if (!r.is_object() || !r.value("following", false))
						continue;
					const auto fid = r.value("formId", std::string()), plugin = r.value("plugin", std::string());
					if (fid.empty() || FindMemberLocked(*lo, fid, plugin))
						continue;
					Member m;
					m.formId   = fid;
					m.plugin   = plugin;
					m.name     = r.value("name", std::string());
					m.original = r.value("original", std::string());
					m.cls      = str("cls", 24);
					if (!ClassExistsLocked(m.cls))
						m.cls.clear();
					lo->members.push_back(m);
					++added;
				}
				SaveLocked();
				return Ok(act, added ? (std::to_string(added) + " added from your party") : "Everyone with you is already in it", id);
			}
			if (act == "loRemove") {
				const auto fid = str("formId", 24), plugin = str("plugin", 120);
				const auto key = KeyOf(fid, plugin);
				const auto before = lo->members.size();
				lo->members.erase(std::remove_if(lo->members.begin(), lo->members.end(),
					[&](const Member& m) { return KeyOf(m.formId, m.plugin) == key; }), lo->members.end());
				if (lo->members.size() == before)
					return Fail(act, "She wasn't in this loadout");
				SaveLocked();
				return Ok(act, "Removed", id);
			}
			if (act == "loSetClass") {
				auto* m = FindMemberLocked(*lo, str("formId", 24), str("plugin", 120));
				if (!m)
					return Fail(act, "She isn't in this loadout");
				const auto cls = str("cls", 24);
				if (!ClassExistsLocked(cls))
					return Fail(act, "That class no longer exists");
				m->cls = cls;
				SaveLocked();
				return Ok(act, cls.empty() ? "Class cleared" : "Class set", id);
			}
			if (act == "loMove") {
				// members: the full new member order, by key
				if (!j.contains("keys") || !j["keys"].is_array())
					return Fail(act, "Bad order");
				std::vector<Member> next;
				for (const auto& e : j["keys"]) {
					if (!e.is_string())
						continue;
					const auto want = e.get<std::string>();
					for (const auto& m : lo->members)
						if (KeyOf(m.formId, m.plugin) == want &&
							std::none_of(next.begin(), next.end(), [&](const Member& n) { return KeyOf(n.formId, n.plugin) == want; }))
							next.push_back(m);
				}
				for (const auto& m : lo->members)
					if (std::none_of(next.begin(), next.end(), [&](const Member& n) { return KeyOf(n.formId, n.plugin) == KeyOf(m.formId, m.plugin); }))
						next.push_back(m);
				lo->members = std::move(next);
				SaveLocked();
				return Ok(act, "Reordered", id);
			}
		}

		// ---- classes ----
		if (act == "clsNew") {
			const auto name = str("name", 60);
			if (name.empty())
				return Fail(act, "Give the class a name");
			Class c;
			c.id   = NewId("c");
			c.name = name;
			c.icon = str("icon", 8);
			g_cfg.classes.push_back(c);
			SaveLocked();
			return Ok(act, "Class \"" + name + "\" created", c.id);
		}
		if (act == "clsRename" || act == "clsNote" || act == "clsIcon" || act == "clsDelete" ||
			act == "clsGearAdd" || act == "clsGearRemove" || act == "clsGearCount" || act == "clsStyle" ||
			act == "clsReplace" || act == "clsSnapshot" || act == "clsReorder") {
			if (act == "clsReorder") {
				if (!j.contains("ids") || !j["ids"].is_array())
					return Fail(act, "Bad order");
				std::vector<Class> next;
				for (const auto& e : j["ids"])
					if (e.is_string())
						if (auto* x = FindClassLocked(e.get<std::string>()))
							next.push_back(*x);
				for (const auto& x : g_cfg.classes)
					if (std::none_of(next.begin(), next.end(), [&](const Class& n) { return n.id == x.id; }))
						next.push_back(x);
				g_cfg.classes = std::move(next);
				SaveLocked();
				return Ok(act, "Reordered");
			}
			auto* c = FindClassLocked(id);
			if (!c)
				return Fail(act, "That class no longer exists");
			if (act == "clsRename") {
				const auto name = str("name", 60);
				if (name.empty())
					return Fail(act, "A class needs a name");
				c->name = name;
				SaveLocked();
				return Ok(act, "Renamed", id);
			}
			if (act == "clsNote") { c->note = str("note", 400); SaveLocked(); return Ok(act, "Note saved", id); }
			if (act == "clsIcon") { c->icon = str("icon", 8); SaveLocked(); return Ok(act, "Icon set", id); }
			if (act == "clsReplace") { c->replace = j.value("on", false); SaveLocked(); return Ok(act, c->replace ? "Will replace worn armour" : "Will add on top", id); }
			if (act == "clsDelete") {
				const auto name = c->name;
				g_cfg.classes.erase(std::remove_if(g_cfg.classes.begin(), g_cfg.classes.end(),
					[&](const Class& x) { return x.id == id; }), g_cfg.classes.end());
				for (auto& lo : g_cfg.loadouts)
					for (auto& m : lo.members)
						if (m.cls == id)
							m.cls.clear();
				SaveLocked();
				return Ok(act, "Class \"" + name + "\" deleted");
			}
			if (act == "clsGearAdd") {
				GearRef g;
				g.plugin = str("plugin", 120);
				g.formId = str("formId", 24);
				g.name   = str("name", 120);
				g.count  = std::clamp(j.value("count", 1), 1, 999);
				if (g.plugin.empty() || g.formId.empty())
					return Fail(act, "No item named");
				auto* form = ActorIdentity::Resolve(g.formId, g.plugin);
				if (g.name.empty())
					g.name = NameOf(form);
				g.kind = KindOf(form);
				for (auto& x : c->gear)
					if (KeyOf(x.formId, x.plugin) == KeyOf(g.formId, g.plugin)) {
						x.count = std::clamp(x.count + g.count, 1, 999);
						SaveLocked();
						return Ok(act, g.name + " x" + std::to_string(x.count), id);
					}
				c->gear.push_back(g);
				SaveLocked();
				return Ok(act, g.name + " added to " + c->name, id);
			}
			if (act == "clsGearRemove" || act == "clsGearCount") {
				const auto key = KeyOf(str("formId", 24), str("plugin", 120));
				auto it = std::find_if(c->gear.begin(), c->gear.end(),
					[&](const GearRef& g) { return KeyOf(g.formId, g.plugin) == key; });
				if (it == c->gear.end())
					return Fail(act, "That piece isn't in the class");
				if (act == "clsGearRemove") {
					c->gear.erase(it);
					SaveLocked();
					return Ok(act, "Removed", id);
				}
				it->count = std::clamp(j.value("count", 1), 1, 999);
				SaveLocked();
				return Ok(act, it->name + " x" + std::to_string(it->count), id);
			}
			if (act == "clsStyle") {
				StyleRef s;
				s.plugin = str("plugin", 120);
				s.formId = str("formId", 24);
				if (s.plugin.empty() && s.formId.empty()) {
					c->style = StyleRef{};
					SaveLocked();
					return Ok(act, "Combat style cleared", id);
				}
				s.name = str("name", 80);
				s.nff  = j.value("nff", -1);
				auto* form = ActorIdentity::Resolve(s.formId, s.plugin);
				if (!form || !form->As<RE::TESCombatStyle>())
					return Fail(act, "That combat style doesn't resolve");
				if (s.name.empty()) {
					if (const char* eid = form->GetFormEditorID(); eid && *eid)
						s.name = eid;
					else
						s.name = "Style " + s.formId;
				}
				c->style = s;
				SaveLocked();
				return Ok(act, "Combat style: " + s.name, id);
			}
			if (act == "clsSnapshot") {
				// Copy what SHE is wearing into the class - armour, weapons, ammo.
				auto* a = ActorIdentity::ResolveActor(str("formId", 24), str("plugin", 120));
				if (!a)
					return Fail(act, "She isn't loaded right now");
				std::vector<GearRef> gear;
				auto inv = a->GetInventory();
				for (auto& [obj, data] : inv) {
					if (!obj || data.first <= 0)
						continue;
					auto* entry = data.second.get();
					if (!entry || !entry->IsWorn())
						continue;
					const auto ft = obj->GetFormType();
					if (ft != RE::FormType::Armor && ft != RE::FormType::Weapon && ft != RE::FormType::Ammo)
						continue;
					GearRef g;
					IdentityOf(obj, g.plugin, g.formId);
					if (g.formId.empty() || g.plugin.empty())
						continue;   // a dynamic (player-made) item cannot be handed out by identity
					g.name  = NameOf(obj);
					g.kind  = KindOf(obj);
					g.count = (ft == RE::FormType::Ammo) ? std::clamp<std::int32_t>(data.first, 1, 999) : 1;
					gear.push_back(g);
				}
				if (gear.empty())
					return Fail(act, NameOf(a) + " is wearing nothing the class could copy");
				c->gear = std::move(gear);
				SaveLocked();
				return Ok(act, "Copied " + std::to_string(c->gear.size()) + " piece(s) from " + NameOf(a), id);
			}
		}

		// ---- physical: validate only ----
		if (IsPhysical(act)) {
			if (!RE::PlayerCharacter::GetSingleton())
				return Fail(act, "No save loaded");
			if (g_job)
				return Fail(act, "Still working on the last order - give it a moment");
			if (act == "partyRelax" || act == "partyUnrelax") {
				// Party-wide by design: NFF has no per-follower sandbox order.
				return Dump(json{ { "ok", true }, { "act", act }, { "physical", true }, { "id", id },
					{ "msg", act == "partyRelax" ? "Everyone, at ease..." : "Everyone back to you..." } });
			}
			if (act == "dressClass") {
				auto* c = FindClassLocked(id);
				if (!c)
					return Fail(act, "That class no longer exists");
				std::size_t wearers = 0;
				for (const auto& l2 : g_cfg.loadouts)
					for (const auto& m : l2.members)
						if (m.cls == id)
							++wearers;
				if (!wearers)
					return Fail(act, c->name + " has no wearers yet");
				return Dump(json{ { "ok", true }, { "act", act }, { "physical", true }, { "id", id },
					{ "msg", "Dressing " + std::to_string(wearers) + " wearer(s) in " + c->name + "..." } });
			}
			auto* lo = FindLoadoutLocked(id);
			if (!lo)
				return Fail(act, "That loadout no longer exists");
			if (lo->members.empty())
				return Fail(act, lo->name + " has nobody in it yet");
			if (act == "dressOne") {
				auto* m = FindMemberLocked(*lo, str("formId", 24), str("plugin", 120));
				if (!m)
					return Fail(act, "She isn't in this loadout");
				if (m->cls.empty())
					return Fail(act, m->name + " has no class in this loadout");
			}
			const std::string opening =
				act == "groupFollow" ? (lo->name + ", follow me...") :
				act == "groupWait"   ? (lo->name + ", wait here...") :
				act == "groupSic"    ? (lo->name + ", attack...") :
				act == "groupDisengage" ? (lo->name + ", break off...") :
									   ("Working on " + lo->name + "...");
			return Dump(json{ { "ok", true }, { "act", act }, { "physical", true }, { "id", id },
				{ "msg", opening } });
		}

		return Fail(act, "Unknown loadout action \"" + act + "\"");
	}

	std::string GroupsByOriginalJson()
	{
		// Who is in which group, keyed by the follower's ORIGINAL name. That is
		// the join the Followers tab (and the portal) can actually make: a
		// runtime FormID is not stable across the places this is read from, and
		// `original` is exactly what Follower Organizer files people under.
		// Small by construction — a handful of groups of a handful of people —
		// so the whole map goes in one reply rather than a per-row query.
		std::lock_guard l(g_m);
		LoadLocked();
		std::map<std::string, std::string> clsName;
		for (const auto& c : g_cfg.classes)
			clsName[c.id] = c.name;
		json by = json::object();
		for (const auto& lo : g_cfg.loadouts) {
			for (const auto& m : lo.members) {
				const std::string key = m.original.empty() ? m.name : m.original;
				if (key.empty())
					continue;
				if (!by.contains(key))
					by[key] = json::array();
				json e{ { "group", lo.name }, { "id", lo.id } };
				auto it = clsName.find(m.cls);
				e["cls"] = (it == clsName.end()) ? "" : it->second;
				by[key].push_back(e);
			}
		}
		return Dump(json{ { "ok", true }, { "byOriginal", by } });
	}

	bool FireActiveOrder(const std::string& what)
	{
		// A bound key has no pane and therefore no selection: it commands the
		// group the player ★-pinned. With exactly one group and no pin we take
		// that one, because "the group" is unambiguous then; with several and no
		// pin we refuse out loud rather than guessing which squad to send.
		std::string id, name;
		std::size_t count = 0;
		{
			std::lock_guard l(g_m);
			LoadLocked();
			count = g_cfg.loadouts.size();
			if (!g_cfg.activeId.empty()) {
				if (auto* lo = FindLoadoutLocked(g_cfg.activeId)) { id = lo->id; name = lo->name; }
			} else if (count == 1) {
				id = g_cfg.loadouts[0].id;
				name = g_cfg.loadouts[0].name;
			}
		}
		if (id.empty()) {
			RE::DebugNotification(count == 0
				? "Loadouts: no groups yet - make one in the Loadouts tab"
				: "Loadouts: no keyed group - open Loadouts and press the star on one");
			return false;
		}
		const std::string req = Dump(json{ { "act", what }, { "id", id } });
		const auto res = ActJson(req);
		const auto rj  = json::parse(res, nullptr, false);
		if (rj.is_discarded() || !rj.value("ok", false)) {
			// ActJson already logged the reason; say it on screen too.
			RE::DebugNotification((name + ": " + (rj.is_discarded() ? std::string("refused")
				: rj.value("msg", std::string("refused")))).c_str());
			return false;
		}
		Execute(req);
		return true;
	}

	void Execute(const std::string& req)
	{
		auto j = json::parse(req, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return;
		const auto actName = j.value("act", std::string());

		// The instant group orders run inline and are done — no job, so they are
		// also not blocked by one and never leave g_job set.
		if (actName == "groupFollow" || actName == "groupWait" || actName == "groupSic" ||
			actName == "groupDisengage" || actName == "partyRelax" || actName == "partyUnrelax") {
			std::string loName;
			std::vector<Member> members;
			{
				std::lock_guard l(g_m);
				LoadLocked();
				if (actName != "partyRelax" && actName != "partyUnrelax") {
					auto* lo = FindLoadoutLocked(j.value("id", std::string()));
					if (!lo || lo->members.empty())
						return;
					loName  = lo->name;
					members = lo->members;
				}
			}
			const std::string msg = RunGroupOrder(actName, loName, members);
			if (!msg.empty()) {
				std::lock_guard l(g_lastM);
				g_lastSummary   = msg;
				g_lastSummaryAt = static_cast<std::int64_t>(
					std::chrono::duration_cast<std::chrono::seconds>(
						std::chrono::system_clock::now().time_since_epoch()).count());
			}
			return;
		}

		auto job   = std::make_shared<Job>();
		job->act   = actName;
		job->mode  = j.value("mode", std::string("add"));
		job->clsFilter = j.value("cls", std::string());
		const auto id = j.value("id", std::string());
		{
			std::lock_guard l(g_m);
			LoadLocked();
			if (g_job) {
				RE::DebugNotification("Loadouts: still working on the last order");
				return;
			}
			if (job->act == "dressClass") {
				// Addressed by CLASS id, not by loadout: every wearer of this class,
				// wherever she is filed. clsFilter keeps phase 2 on that class even
				// for someone who is also in a group with a different one.
				auto* c = FindClassLocked(id);
				if (!c)
					return;
				job->loName    = c->name;
				job->clsFilter = id;
				std::set<std::string> seen;
				for (const auto& l2 : g_cfg.loadouts)
					for (const auto& m : l2.members)
						if (m.cls == id && seen.insert(KeyOf(m.formId, m.plugin)).second)
							job->members.push_back(m);
				if (job->members.empty())
					return;
			} else {
				auto* lo = FindLoadoutLocked(id);
				if (!lo || lo->members.empty())
					return;
				job->loName  = lo->name;
				job->members = lo->members;
				if (job->act == "dressOne") {
					const auto want = KeyOf(j.value("formId", std::string()), j.value("plugin", std::string()));
					std::vector<Member> one;
					for (const auto& m : lo->members)
						if (KeyOf(m.formId, m.plugin) == want)
							one.push_back(m);
					job->members = std::move(one);
				}
			}
		}
		if (job->act == "deploy" && job->mode == "swap") {
			// Everyone with you who is NOT in the group leaves first.
			std::set<std::string> keep;
			for (const auto& m : job->members)
				keep.insert(KeyOf(m.formId, m.plugin));
			if (auto* lists = RE::ProcessLists::GetSingleton()) {
				auto* player = RE::PlayerCharacter::GetSingleton();
				for (auto& h : lists->highActorHandles) {
					auto       ptr = h.get();
					RE::Actor* a   = ptr ? ptr.get() : nullptr;
					if (!a || a == player || a->IsPlayerRef() || a->IsDead() || !IsFollowing(a))
						continue;
					// Her own follower mod owns her: NFF's dismiss would only export
					// her, and the F7 card already treats that as a separate verb.
					if (FollowerFrameworks::OwningCompanionSpec(a) >= 0)
						continue;
					Member m;
					IdentityOf(a, m.formId, m.plugin);
					if (m.formId.empty() || keep.count(KeyOf(m.formId, m.plugin)))
						continue;
					m.name = NameOf(a);
					job->toDismiss.push_back(m);
				}
			}
		}
		g_job = job;
		logger::info("loadouts: {} \"{}\" ({} member(s), mode {}, {} to dismiss first)",
			job->act, job->loName, job->members.size(), job->mode, job->toDismiss.size());   // marker: loadouts: deploy
		RE::DebugNotification((job->loName + ": " +
			(job->act == "deploy" ? "gathering the group..." :
			 job->act == "summon" ? "calling everyone to you..." :
			 job->act == "dismiss" ? "sending everyone off..." :
			 job->act == "dressClass" ? "dressing everyone in this class..." : "dressing the group...")).c_str());
		Step(job);
	}

	int OnPostLoadGame()
	{
		ResetNffScan();
		// The deck's memory of "the party is relaxing" cannot survive a load —
		// the save has its own sandbox state and nothing exposes it. Default to
		// the safe reading; pressing Relax when they already are is a no-op.
		g_partyRelaxed.store(false);
		std::map<std::string, StyleRef> applied;
		std::vector<Loadout>            los;
		{
			std::lock_guard l(g_m);
			LoadLocked();
			applied = g_cfg.applied;
			los     = g_cfg.loadouts;
		}
		if (applied.empty())
			return 0;
		int n = 0;
		for (const auto& [key, st] : applied) {
			// Find the identity behind the key from any loadout membership.
			const Member* who = nullptr;
			for (const auto& lo : los)
				for (const auto& m : lo.members)
					if (!who && KeyOf(m.formId, m.plugin) == key)
						who = &m;
			if (!who)
				continue;
			auto* a = ActorIdentity::ResolveActor(who->formId, who->plugin);
			if (!a || a->IsDead())
				continue;
			std::string note;
			if (ApplyStyle(a, st, note))
				++n;
		}
		if (n)
			logger::info("loadouts: re-applied {} combat style(s) after load", n);
		return n;
	}
}
