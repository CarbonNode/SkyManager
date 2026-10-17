#include "interact_actions.h"

#include "actor_identity.h"
#include "camp_actions.h"
#include "npc_actions.h"

#include <chrono>
#include <cctype>
#include <cmath>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>

// pch (force-included) provides RE::/SKSE::/json and the logger.

namespace InteractActions
{
	namespace
	{
		using json = nlohmann::json;
		namespace fs = std::filesystem;

		// Who a door applies to. The card can be pointed at anyone, so every row
		// says what it needs and the state reply explains a mismatch.
		enum class Who { Person, Creature, Horse, Any };
		enum class Life { Alive, Dead, Either };
		// How the tile reaches the mod:
		//   Cast      cast the mod's spell from the player AT the person;
		//   CastCross the same, for a script that also reads the crosshair;
		//   Self      self-cast the mod's power — its script reads the crosshair;
		//   Key       press the mod's own hotkey — its handler reads the crosshair.
		// Every kind but Cast works only on the person the deck was opened
		// looking at (NpcActions::TargetFormID), and the camp verbs likewise.
		enum class Via { Cast, CastCross, Self, Key };

		struct Door
		{
			const char*   id;       // the view's tile id
			const char*   mod;      // the mod key: hide settings + messages
			const char*   modName;  // display
			const char*   plugin;
			std::uint32_t local;    // local FormID of the SPEL
			Who           who;
			Life          life;
			bool          hideable;
			bool          hideDefault;
			const char*   needDll;  // a runtime library the spell's script calls, or nullptr
			const char*   campVerb; // non-null: fire this CampActions verb instead of casting at them
			Via           via = Via::Cast;
			// Via::Key: where the mod keeps its key. An MCM Helper setting
			// (Data/MCM/Settings/<mcm>.ini over Data/MCM/Config/<mcm>/settings.ini),
			// or — keyGlob — the GLOB at `local` in `plugin`, read live from the game.
			const char*   mcm = nullptr;
			const char*   mcmSection = nullptr;
			const char*   mcmKey = nullptr;
			bool          keyGlob = false;
		};

		// Every row read from the real plugin (survey of the CS 1.9.1 UW Test
		// load order, 2026-10-14 — scripted powers with Target Actor delivery;
		// Carry Me's also with tools/dump_records.py). Not guessed: a wrong id
		// resolves to nothing, the row reads as not installed, and the tile is
		// not drawn.
		constexpr Door kDoors[] = {
			// Carry Me (Nexus 194011): 00PBR_CanIRideYouSpell "Can I Ride You?"
			{ "carry", "carryme", "Carry Me", "PiggyBackRide.esp", 0xD63, Who::Person, Life::Alive, true, true, "Piggyback.dll", nullptr },
			// Kiss Any Woman Shout: KissAnyWomanShout (Space ends it — the mod's key)
			{ "kiss", "kissany", "Kiss Any Woman", "shadowman_kissanywoman.esp", 0x801, Who::Person, Life::Alive, true, false, nullptr, nullptr },
			// Ace Romance Animations (no framework): RomanceAceShout — opens its pose list
			{ "romance", "aceromance", "Ace Romance Animations", "RomanceAceShout.esp", 0x801, Who::Person, Life::Alive, true, false, nullptr, nullptr },
			// Spooning of Skyrim: HSFPickSpoonerSpell "Set Spooning Partner" — its A/B/C slot box
			{ "spoon", "spooning", "Spooning of Skyrim", "Spooning Of Skyrim.esp", 0xD65, Who::Person, Life::Alive, true, false, nullptr, nullptr },
			// WagonBorn: FEN_WB_CartFo1..4Spell "Cart Passenger N", FEN_WB_CartSattelnSpell "Horse saddle"
			{ "cart1", "wagonborn", "WagonBorn", "WagonBorn.esp", 0x147, Who::Person, Life::Alive, true, false, nullptr, nullptr },
			{ "cart2", "wagonborn", "WagonBorn", "WagonBorn.esp", 0x098, Who::Person, Life::Alive, true, false, nullptr, nullptr },
			{ "cart3", "wagonborn", "WagonBorn", "WagonBorn.esp", 0x1E4, Who::Person, Life::Alive, true, false, nullptr, nullptr },
			{ "cart4", "wagonborn", "WagonBorn", "WagonBorn.esp", 0x1E5, Who::Person, Life::Alive, true, false, nullptr, nullptr },
			{ "saddle", "wagonborn", "WagonBorn", "WagonBorn.esp", 0x00D, Who::Horse, Life::Alive, true, false, nullptr, nullptr },
			// Standalone EFF Cosmetic Menu: EFFStandCosMenuSpell — UIExtensions cosmetic menu on them
			{ "cosmetics", "effcosmetic", "EFF Cosmetic Menu", "EFFStandCosMenu.esp", 0xD62, Who::Person, Life::Alive, true, false, nullptr, nullptr },
			// F.E.P. (Facial Expressions Project): _00FaceMenuNPCSpell2 "Npc Expressions"
			{ "expressions", "fep", "Facial Expressions Project", "00FacialExpressions.esp", 0x808, Who::Person, Life::Alive, true, false, nullptr, nullptr },
			// 3BBB: 3BSMPTOGGLE_A "3BBB Physics Toggle - NPC"
			{ "physics", "3bbb", "3BBB", "3BBB.esp", 0x80D, Who::Person, Life::Alive, true, false, nullptr, nullptr },
			// Hunterborn: _DS_SPEL_Taxonomy + the _DS_SPEL_Hotkey_* corpse spells (its own hotkey spells — never
			// hidden). Hunterborn reads the carcass under the CROSSHAIR, and a spell does not land on a corpse, so
			// these fire the deck's existing Campfire/Hunterborn verbs (camp_actions.cpp, the same self-cast its
			// hotkeys make) and only for the person the deck was opened looking at.
			{ "hb-taxonomy", "hunterborn", "Hunterborn", "Hunterborn.esp", 0x215DA, Who::Creature, Life::Either, false, false, nullptr, "hb-taxonomy" },
			{ "hb-fielddress", "hunterborn", "Hunterborn", "Hunterborn.esp", 0x44EC6, Who::Creature, Life::Dead, false, false, nullptr, "hb-fielddress" },
			{ "hb-skin", "hunterborn", "Hunterborn", "Hunterborn.esp", 0x44EC9, Who::Creature, Life::Dead, false, false, nullptr, "hb-skin" },
			{ "hb-harvest", "hunterborn", "Hunterborn", "Hunterborn.esp", 0x44ECB, Who::Creature, Life::Dead, false, false, nullptr, "hb-harvest" },
			{ "hb-butcher", "hunterborn", "Hunterborn", "Hunterborn.esp", 0x44ECD, Who::Creature, Life::Dead, false, false, nullptr, "hb-butcher" },
			{ "hb-process", "hunterborn", "Hunterborn", "Hunterborn.esp", 0x44ECF, Who::Creature, Life::Dead, false, false, nullptr, "hb-process" },

			// ---- pass 2 (2026-10-14): mods whose scripts act on the CROSSHAIR ----
			// (loose .pex scanned for GetCurrentCrosshairRef; ids from the survey /
			// dump_records.py; every mod confirmed ticked + plugin ticked in the live profile)
			// Irresistible SSE: OPIrresistible.esp "Irresistible" (aimed spell) + "Irresistible - Lover Options" (lesser power, self)
			{ "seduce", "irresistible", "Irresistible", "OPIrresistible.esp", 0x803, Who::Person, Life::Alive, true, false, nullptr, nullptr, Via::CastCross },
			{ "loveropts", "irresistible", "Irresistible", "OPIrresistible.esp", 0x827, Who::Person, Life::Alive, true, false, nullptr, nullptr, Via::Self },
			// Shadowmans Animations: shadowman_animations.esp "Shadowman Animations Shout" (lesser power, self) — its UIListMenu
			{ "shadowanim", "shadowanim", "Shadowman Animations", "shadowman_animations.esp", 0x801, Who::Person, Life::Alive, true, false, nullptr, nullptr, Via::Self },
			// OBody NG: its preset key (OBodyNGScript reads the crosshair) — MCM Helper "OBody" [Settings] iPresetKey
			{ "obody", "obody", "OBody NG", "OBody.esp", 0, Who::Person, Life::Alive, false, false, "OBody.dll", nullptr, Via::Key, "OBody", "Settings", "iPresetKey" },
			// Follower Stats: its stats key on the crosshair actor — MCM Helper "Follower Stats" [Main] iHotkey (ships unbound, -1)
			{ "fstats", "followerstats", "Follower Stats", "Follower Stats.esp", 0, Who::Person, Life::Either, false, false, nullptr, nullptr, Via::Key, "Follower Stats", "Main", "iHotkey" },
			// Kick Them All: its kick key on the crosshair NPC — MCM Helper "KickThemAll" [General] iHotkey
			{ "kick", "kickthemall", "Kick Them All", "KickThemAll.esp", 0, Who::Any, Life::Alive, false, false, nullptr, nullptr, Via::Key, "KickThemAll", "General", "iHotkey" },
			// Jaxonz Renamer: its rename key on the crosshair — GLOB JaxonzRenamerHotkey (0xD63, default 43 = \\)
			{ "rename", "jaxonz", "Jaxonz Renamer", "JaxonzRenamer.esp", 0xD63, Who::Any, Life::Either, false, false, nullptr, nullptr, Via::Key, nullptr, nullptr, nullptr, true },
		};

		// Carry Me's "being carried" marker: 00PBR_ImRidingYouSpell, on the player while carried.
		constexpr std::uint32_t kImRidingYou = 0x002;
		constexpr float         kReach       = 1000.0f;   // ~14 m: walk up to them, not across the hall

		const Door* FindDoor(const std::string& id)
		{
			for (const auto& d : kDoors)
				if (id == d.id)
					return &d;
			return nullptr;
		}

		std::string Dump(const json& j)
		{
			return j.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		std::string Refuse(const std::string& op, const std::string& msg)
		{
			return Dump(json{ { "ok", false }, { "op", op }, { "phase", "refused" }, { "msg", msg } });
		}

		std::string NameOf(RE::Actor* a)
		{
			if (a)
				if (const char* n = a->GetDisplayFullName(); n && *n)
					return n;
			return "They";
		}

		RE::SpellItem* SpellOf(const char* plugin, std::uint32_t local)
		{
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh)
				return nullptr;
			auto* f = dh->LookupForm(local, plugin);
			return f ? f->As<RE::SpellItem>() : nullptr;
		}
		RE::SpellItem* SpellOf(const Door& d) { return d.via == Via::Key ? nullptr : SpellOf(d.plugin, d.local); }

		bool PluginLoaded(const char* plugin)
		{
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh || !plugin)
				return false;
			const std::string_view name(plugin);
			return dh->LookupLoadedModByName(name) || dh->LookupLoadedLightModByName(name);
		}

		RE::TESGlobal* GlobOf(const Door& d)
		{
			auto* dh = RE::TESDataHandler::GetSingleton();
			auto* f = dh ? dh->LookupForm(d.local, d.plugin) : nullptr;
			return f ? f->As<RE::TESGlobal>() : nullptr;
		}

		bool DllLoaded(const char* name)
		{
			if (!name)
				return true;
			std::wstring w(name, name + std::strlen(name));
			return GetModuleHandleW(w.c_str()) != nullptr;
		}
		bool RideAlongDll() { return GetModuleHandleW(L"RideAlong.dll") != nullptr; }

		bool RaceHas(RE::Actor* a, const char* kw)
		{
			auto* race = a ? a->GetRace() : nullptr;
			return race && race->HasKeywordString(kw);
		}
		bool IsPerson(RE::Actor* a) { return RaceHas(a, "ActorTypeNPC"); }
		bool IsHorse(RE::Actor* a) { return RaceHas(a, "ActorTypeHorse"); }

		// ---- the sidecar: Data/SKSE/Plugins/HotkeyDeck/interact.json -----------
		// { "hide": { "<mod id>": bool } }. Unknown keys are kept on write, so a
		// newer view/DLL's fields survive. (The first build wrote a top-level
		// "hideCarryPower"; it is read as hide.carryme when that is unset.)
		std::mutex g_cfgMutex;
		json       g_cfg;
		bool       g_cfgLoaded = false;

		fs::path CfgPath() { return fs::path("Data") / "SKSE" / "Plugins" / "HotkeyDeck" / "interact.json"; }

		void LoadCfgLocked()
		{
			if (g_cfgLoaded)
				return;
			g_cfgLoaded = true;
			g_cfg = json::object();
			std::ifstream in(CfgPath(), std::ios::binary);
			if (!in)
				return;
			auto j = json::parse(in, nullptr, false);
			if (!j.is_discarded() && j.is_object())
				g_cfg = std::move(j);
		}

		bool Hidden(const Door& d)
		{
			if (!d.hideable)
				return false;
			std::lock_guard lk(g_cfgMutex);
			LoadCfgLocked();
			if (auto h = g_cfg.find("hide"); h != g_cfg.end() && h->is_object())
				if (auto v = h->find(d.mod); v != h->end() && v->is_boolean())
					return v->get<bool>();
			if (std::string_view(d.mod) == "carryme")
				if (auto v = g_cfg.find("hideCarryPower"); v != g_cfg.end() && v->is_boolean())
					return v->get<bool>();
			return d.hideDefault;
		}

		bool SetHidden(const std::string& mod, bool hide)
		{
			std::lock_guard lk(g_cfgMutex);
			LoadCfgLocked();
			if (!g_cfg.contains("hide") || !g_cfg["hide"].is_object())
				g_cfg["hide"] = json::object();
			g_cfg["hide"][mod] = hide;
			std::error_code ec;
			fs::create_directories(CfgPath().parent_path(), ec);
			std::ofstream out(CfgPath(), std::ios::binary | std::ios::trunc);
			if (!out) {
				logger::warn("interact: could not write interact.json");
				return false;
			}
			out << g_cfg.dump(2, ' ', false, json::error_handler_t::replace);
			return true;
		}

		// Take a power off the player (or give it back). True when it changed.
		bool ApplyPower(const Door& d, bool hide)
		{
			auto* player = RE::PlayerCharacter::GetSingleton();
			auto* spell = SpellOf(d);
			if (!player || !spell || !d.hideable)
				return false;
			const bool known = player->HasSpell(spell);
			if (hide && known) {
				player->RemoveSpell(spell);
				logger::info("interact: {} power {:06X} hidden (taken off the player)", d.modName, d.local);   // marker: interact-hide-power
				return true;
			}
			if (!hide && !known) {
				player->AddSpell(spell);
				logger::info("interact: {} power {:06X} given back to the player", d.modName, d.local);
				return true;
			}
			return false;
		}

		void ApplyAllHides()
		{
			for (const auto& d : kDoors)
				if (d.hideable && SpellOf(d) && Hidden(d))
					ApplyPower(d, true);
		}

		RE::Actor* Subject(const json& j)
		{
			const std::string fid = j.value("formId", std::string());
			if (!fid.empty())
				return ActorIdentity::ResolveActor(fid, j.value("plugin", std::string()));
			if (const auto id = NpcActions::TargetFormID())
				return RE::TESForm::LookupByID<RE::Actor>(id);
			return nullptr;
		}

		bool Carried()
		{
			auto* player = RE::PlayerCharacter::GetSingleton();
			auto* riding = SpellOf("PiggyBackRide.esp", kImRidingYou);
			return player && riding && player->HasSpell(riding);
		}

		// Is the mod actually running in this game? (Not "installed in MO2": a row
		// whose plugin did not load, or whose DLL is absent, draws no tile.)
		bool Installed(const Door& d)
		{
			if (!DllLoaded(d.needDll))
				return false;
			if (d.via != Via::Key)
				return SpellOf(d) != nullptr;
			if (d.keyGlob)
				return GlobOf(d) != nullptr;
			return PluginLoaded(d.plugin);
		}

		bool NeedsCrosshair(const Door& d)
		{
			return d.campVerb || d.via != Via::Cast;
		}

		// "" = this door can be used on them now; otherwise the sentence why not.
		std::string WhyNot(const Door& d, RE::Actor* a)
		{
			auto* player = RE::PlayerCharacter::GetSingleton();
			if (!Installed(d) && DllLoaded(d.needDll))
				return d.modName + std::string(" isn't loaded (") + d.plugin + " is not in the load order)";
			if (!DllLoaded(d.needDll))
				return d.modName + std::string(" needs ") + d.needDll + ", which is not loaded";
			if (!player)
				return "No save is loaded";
			if (!a)
				return "They aren't loaded right now";
			if (a->IsPlayerRef())
				return "That's you";
			const std::string name = NameOf(a);
			if (!a->Is3DLoaded())
				return name + " isn't loaded right now - get closer";

			const bool person = IsPerson(a);
			const bool horse = IsHorse(a);
			switch (d.who) {
			case Who::Person:
				if (!person)
					return std::string(d.modName) + " is for people, and " + name + " isn't one";
				break;
			case Who::Creature:
				if (person)
					return std::string(d.modName) + " is for animals and creatures";
				break;
			case Who::Horse:
				if (!horse)
					return std::string(d.modName) + " needs a horse here";
				break;
			case Who::Any:
				break;
			}
			const bool dead = a->IsDead();
			if (d.life == Life::Alive && dead)
				return name + " is dead";
			if (d.life == Life::Dead && !dead)
				return "Only on a carcass - " + name + " is still alive";
			if (!dead && a->IsInCombat() && d.who != Who::Creature)
				return name + " is fighting - wait until it's over";
			if (a->GetPosition().GetDistance(player->GetPosition()) > kReach)
				return name + " is too far away - walk up to them first";
			if (NeedsCrosshair(d) && a->GetFormID() != NpcActions::TargetFormID())
				return std::string(d.modName) + " works on whoever is under your crosshair - look at " + name + " and press F7";

			if (std::string_view(d.id) == "carry") {
				if (Carried())
					return "You're already being carried - jump to get down first";
				if (player->IsOnMount())
					return "Get off your horse first";
				if (a->IsOnMount())
					return name + " is on a horse";
				if (auto* s = a->AsActorState(); s && s->GetSitSleepState() != RE::SIT_SLEEP_STATE::kNormal)
					return name + " is sitting or lying down - ask them up first";
			}
			return "";
		}

		bool IsPersonFollower(RE::Actor* a)
		{
			return a && !a->IsPlayerRef() && !a->IsDead() && a->IsPlayerTeammate() && IsPerson(a);
		}

		// Ride Along seats the NEAREST follower; refuse when that is somebody else.
		std::string RideWhyNot(RE::Actor* a)
		{
			auto* player = RE::PlayerCharacter::GetSingleton();
			if (!RideAlongDll())
				return "Ride Along isn't installed (RideAlong.dll is not loaded)";
			if (!player)
				return "No save is loaded";
			if (!a)
				return "They aren't loaded right now";
			if (a->IsPlayerRef())
				return "That's you";
			const std::string name = NameOf(a);
			if (!player->IsOnMount())
				return "Mount your horse first - Ride Along seats a follower behind you";
			if (a->IsDead())
				return name + " is dead";
			if (!IsPersonFollower(a))
				return "Ride Along only seats followers, and " + name + " isn't following you";
			const auto here = player->GetPosition();
			RE::Actor* nearest = nullptr;
			float best = a->GetPosition().GetDistance(here);
			if (auto* lists = RE::ProcessLists::GetSingleton()) {
				for (auto& h : lists->highActorHandles) {
					auto other = h.get();
					auto* o = other.get();
					if (!o || o == a || !IsPersonFollower(o) || !o->Is3DLoaded())
						continue;
					const float dist = o->GetPosition().GetDistance(here);
					if (dist + 1.0f < best) {
						best = dist;
						nearest = o;
					}
				}
			}
			if (nearest)
				return "Ride Along takes the follower nearest you, and that's " + NameOf(nearest) +
					", not " + name + " - bring " + name + " closer first";
			return "";
		}

		float Wrap(float a)
		{
			constexpr float tau = 6.28318530718f;
			a = std::fmod(a, tau);
			return a < 0.0f ? a + tau : a;
		}

		// One `key = value` integer from an ini [section]. Worker thread (file IO).
		bool ReadIni(const fs::path& path, const char* section, const char* key, long& out)
		{
			std::ifstream in(path, std::ios::binary);
			if (!in)
				return false;
			auto lower = [](std::string v) {
				for (auto& c : v)
					c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
				return v;
			};
			auto trim = [](std::string v) {
				const auto b = v.find_first_not_of(" \t\r\n");
				const auto e = v.find_last_not_of(" \t\r\n");
				return b == std::string::npos ? std::string() : v.substr(b, e - b + 1);
			};
			const std::string want = lower(section), wantKey = lower(key);
			std::string line, cur;
			while (std::getline(in, line)) {
				line = trim(line);
				if (line.empty() || line[0] == ';' || line[0] == '#')
					continue;
				if (line.front() == '[' && line.back() == ']') {
					cur = lower(trim(line.substr(1, line.size() - 2)));
					continue;
				}
				if (cur != want)
					continue;
				const auto eq = line.find('=');
				if (eq == std::string::npos || lower(trim(line.substr(0, eq))) != wantKey)
					continue;
				const std::string v = trim(line.substr(eq + 1));
				try {
					std::size_t used = 0;
					out = std::stol(v, &used, 0);
					return used > 0;
				} catch (...) {
					return false;
				}
			}
			return false;
		}

		struct CastJob
		{
			std::string door;
			RE::FormID  subject = 0;
			std::string name;
			std::string style;   // Carry Me only: auto | piggyback | bridal | front | shoulder
			int         tries = 0;
			bool        asked = false;   // weapon draw/sheathe already requested
		};

		void Later(CastJob job, int ms);

		void Say(const std::string& msg)
		{
			logger::info("interact: {}", msg);
			RE::DebugNotification(msg.c_str());
		}

		// One step of a cast. Main thread. Waits for the game to run (the palette
		// is closing); for Carry Me's styles settles the player's weapon and turns
		// the carrier so the player stands where that style needs; then casts the
		// mod's own spell at them.
		void Step(CastJob job)
		{
			const Door* d = FindDoor(job.door);
			if (!d)
				return;
			if (auto* ui = RE::UI::GetSingleton(); ui && ui->GameIsPaused()) {
				if (++job.tries > 30)
					return Say(std::string(d->modName) + ": a menu is still open, so nothing was cast");
				return Later(std::move(job), 100);
			}
			auto* player = RE::PlayerCharacter::GetSingleton();
			auto* a = RE::TESForm::LookupByID<RE::Actor>(job.subject);
			if (!player || !a || !ActorIdentity::IsLive(a))
				return Say(std::string(d->modName) + ": " + job.name + " left before it could start");
			if (const auto why = WhyNot(*d, a); !why.empty())
				return Say(std::string(d->modName) + ": " + why);

			const bool carry = job.door == "carry";
			if (carry && job.style != "auto") {
				const bool wantDrawn = job.style == "front" || job.style == "shoulder";
				auto* st = player->AsActorState();
				const auto ws = st ? st->GetWeaponState() : RE::WEAPON_STATE::kSheathed;
				const auto want = wantDrawn ? RE::WEAPON_STATE::kDrawn : RE::WEAPON_STATE::kSheathed;
				if (ws != want) {
					if (!job.asked) {
						player->DrawWeaponMagicHands(wantDrawn);
						job.asked = true;
					}
					if (++job.tries > 40)
						return Say(std::string("Carry Me: your weapon would not ") +
							(wantDrawn ? "come out" : "go away") + ", so nobody was asked");
					return Later(std::move(job), 100);
				}
				// Carry Me reads GetHeadingAngle(player) on the carrier: +-90 is
				// "in front". Heading 0 faces +Y; the angle to a point is atan2(dx, dy).
				const auto me = player->GetPosition();
				const auto them = a->GetPosition();
				const float toPlayer = std::atan2(me.x - them.x, me.y - them.y);
				const bool inFront = job.style == "bridal" || job.style == "front";
				a->SetHeading(Wrap(inFront ? toPlayer : toPlayer + 3.14159265359f));
			}

			if (d->campVerb) {
				logger::info("interact: cast {} via the {} verb at '{}' ({:08X})", d->id, d->campVerb, job.name, job.subject);
				CampActions::Fire(d->campVerb);
				return;
			}
			auto* spell = SpellOf(*d);
			auto* caster = player->GetMagicCaster(RE::MagicSystem::CastingSource::kInstant);
			if (!spell || !caster)
				return Say(std::string(d->modName) + ": the spell could not be cast");
			// Self: the power lands on the player and its script reads the crosshair.
			caster->CastSpellImmediate(spell, false, d->via == Via::Self ? static_cast<RE::Actor*>(player) : a,
				1.0f, false, 0.0f, player);
			// Build marker (hd-markers.json "interact-cast").
			logger::info("interact: cast {} ({} {:06X}) at '{}' ({:08X}) style {}",
				d->id, d->plugin, d->local, job.name, job.subject, job.style.empty() ? "-" : job.style);
			if (carry) {
				static const std::unordered_map<std::string, std::string> kWord{
					{ "piggyback", "a piggyback ride" }, { "bridal", "a bridal carry" },
					{ "front", "a front carry" }, { "shoulder", "a shoulder ride" },
				};
				const auto w = kWord.find(job.style);
				RE::DebugNotification((w != kWord.end()
					? "You ask " + job.name + " for " + w->second + ". Jump to get down."
					: "You ask " + job.name + " to carry you. Jump to get down.").c_str());
			}
		}

		void Later(CastJob job, int ms)
		{
			std::thread([job = std::move(job), ms]() mutable {
				std::this_thread::sleep_for(std::chrono::milliseconds(ms));
				SKSE::GetTaskInterface()->AddTask([job = std::move(job)]() mutable { Step(std::move(job)); });
			}).detach();
		}
	}

	std::unordered_map<std::string, std::string> KeyProblems()
	{
		std::unordered_map<std::string, std::string> out;
		for (const auto& d : kDoors) {
			if (d.via != Via::Key || d.keyGlob)
				continue;
			ModKeys::Spec spec;
			const auto p = KeyPress(d.id, 0, spec);
			if (!p.ok)
				out.emplace(d.id, p.msg);
		}
		return out;
	}

	std::string State(const std::string& reqJson, const std::unordered_map<std::string, std::string>& keyWhy)
	{
		const auto j = json::parse(reqJson, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return Refuse("state", "bad request");
		auto* a = Subject(j);
		auto* player = RE::PlayerCharacter::GetSingleton();

		// Keep the settings true to themselves every time the popout looks (a new
		// game's OnInit hands powers out after our load hook may have run).
		ApplyAllHides();

		json doors = json::array();
		json mods = json::array();
		std::unordered_map<std::string, std::size_t> modAt;
		for (const auto& d : kDoors) {
			auto* spell = SpellOf(d);
			const bool installed = Installed(d);
			auto why = installed ? WhyNot(d, a) : std::string();
			if (installed && why.empty() && d.via == Via::Key) {
				if (d.keyGlob) {
					const auto* g = GlobOf(d);
					const long v = g ? static_cast<long>(g->value) : 0;
					if (v <= 0 || v >= 255)
						why = std::string(d.modName) + " has no key bound - set one in its MCM";
				} else if (auto k = keyWhy.find(d.id); k != keyWhy.end()) {
					why = k->second;
				}
			}
			doors.push_back(json{ { "id", d.id }, { "mod", d.mod }, { "installed", installed },
				{ "ready", installed && why.empty() }, { "why", why } });
			if (!installed)
				continue;
			const bool known = player && spell && player->HasSpell(spell);
			auto it = modAt.find(d.mod);
			if (it == modAt.end()) {
				modAt.emplace(d.mod, mods.size());
				mods.push_back(json{ { "id", d.mod }, { "name", d.modName }, { "hideable", d.hideable },
					{ "hidden", Hidden(d) }, { "known", known } });
			} else if (known) {
				mods[it->second]["known"] = true;
			}
		}
		const auto rideWhy = RideWhyNot(a);
		char hex[16]{};
		std::snprintf(hex, sizeof(hex), "0x%08X", a ? a->GetFormID() : 0u);
		return Dump(json{
			{ "ok", true }, { "op", "state" }, { "name", NameOf(a) }, { "formId", std::string(hex) },
			{ "subject", { { "person", IsPerson(a) }, { "creature", a && !IsPerson(a) },
				{ "horse", IsHorse(a) }, { "dead", a && a->IsDead() } } },
			{ "doors", doors }, { "mods", mods }, { "carried", Carried() },
			{ "ride", {
				{ "installed", RideAlongDll() }, { "mounted", player && player->IsOnMount() },
				{ "ready", rideWhy.empty() }, { "why", rideWhy } } },
		});
	}

	std::string Cast(const std::string& reqJson)
	{
		const auto j = json::parse(reqJson, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return Refuse("cast", "bad request");
		const Door* d = FindDoor(j.value("door", std::string()));
		if (!d)
			return Refuse("cast", "Unknown interaction");   // the table is the allowlist
		std::string style;
		if (std::string_view(d->id) == "carry") {
			style = j.value("style", std::string("auto"));
			if (style != "piggyback" && style != "bridal" && style != "front" && style != "shoulder")
				style = "auto";
		}
		auto* a = Subject(j);
		if (const auto why = WhyNot(*d, a); !why.empty())
			return Refuse("cast", why);
		if (d->via == Via::Key) {
			// The caller (main.cpp) closes the palette, resolves the key on a
			// worker (KeyPress: the MCM ini is file IO) and presses it once the
			// game runs. A GLOB key is read here, on the main thread.
			long glob = 0;
			if (d->keyGlob)
				if (auto* g = GlobOf(*d))
					glob = static_cast<long>(g->value);
			// Build marker (hd-markers.json "interact-key").
			logger::info("interact: key {} for '{}' ({:08X}) - {}", d->id, NameOf(a), a->GetFormID(),
				d->keyGlob ? "GLOB" : "MCM Helper ini");
			return Dump(json{ { "ok", true }, { "op", "cast" }, { "phase", "sent" }, { "door", d->id },
				{ "name", NameOf(a) }, { "press", { { "glob", glob } } },
				{ "msg", std::string(d->modName) + ": pressing its key for " + NameOf(a) } });
		}
		CastJob job;
		job.door = d->id;
		job.subject = a->GetFormID();
		job.name = NameOf(a);
		job.style = style;
		const std::string name = job.name;
		Later(std::move(job), 150);   // after the palette has let go of the pause
		return Dump(json{ { "ok", true }, { "op", "cast" }, { "phase", "sent" }, { "door", d->id },
			{ "style", style }, { "name", name },
			{ "msg", std::string(d->modName) + ": starting with " + name } });
	}

	std::string RideCheck(const std::string& reqJson)
	{
		const auto j = json::parse(reqJson, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return Refuse("ride", "bad request");
		auto* a = Subject(j);
		if (const auto why = RideWhyNot(a); !why.empty())
			return Refuse("ride", why);
		// Build marker (hd-markers.json "interact-ride").
		logger::info("interact: ride - pressing Ride Along's key for '{}'", NameOf(a));
		return Dump(json{ { "ok", true }, { "op", "ride" }, { "phase", "sent" }, { "name", NameOf(a) },
			{ "msg", NameOf(a) + ": pressing Ride Along's key (it seats them, or lets them off)" } });
	}

	ModKeys::Spec RideAlongSpec()
	{
		ModKeys::Spec s;
		s.file = "RideAlong.ini";
		s.section = "General";
		s.key = "Hotkey";
		s.space = "dik";
		s.mod = "Ride Along";
		s.where = "RideAlong.ini (Data/SKSE/Plugins) - Ride Along has no in-game menu";
		return s;
	}

	ModKeys::Press KeyPress(const std::string& door, long globValue, ModKeys::Spec& spec)
	{
		ModKeys::Press p;
		const Door* d = FindDoor(door);
		if (!d || d->via != Via::Key) {
			p.msg = "That interaction has no key";
			return p;
		}
		spec = ModKeys::Spec{};
		spec.mod = d->modName;
		spec.space = "dik";
		long raw = 0;
		bool found = false;
		if (d->keyGlob) {
			spec.file = d->plugin;
			spec.key = "GLOB";
			raw = globValue;
			found = true;
		} else {
			// MCM Helper: the user's Data/MCM/Settings/<mcm>.ini wins over the
			// mod's own Data/MCM/Config/<mcm>/settings.ini defaults.
			spec.section = d->mcmSection;
			spec.key = d->mcmKey;
			const fs::path user = fs::path("Data") / "MCM" / "Settings" / (std::string(d->mcm) + ".ini");
			const fs::path dflt = fs::path("Data") / "MCM" / "Config" / d->mcm / "settings.ini";
			for (const auto& f : { user, dflt }) {
				if (ReadIni(f, d->mcmSection, d->mcmKey, raw)) {
					spec.file = PathU8(f);
					found = true;
					break;
				}
			}
		}
		p.raw = raw;
		const std::string where = std::string(d->modName) + "'s MCM";
		if (!found) {
			p.msg = std::string(d->modName) + ": couldn't read its key - set one in " + where + ".";
			return p;
		}
		if (raw <= 0 || raw >= 255) {
			p.msg = std::string(d->modName) + " has no key bound - set one in " + where + ", then try again.";
			return p;
		}
		p.dik = static_cast<std::uint32_t>(raw);
		p.ok = true;
		return p;
	}

	std::string Power(const std::string& reqJson)
	{
		const auto j = json::parse(reqJson, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return Refuse("power", "bad request");
		const std::string mod = j.value("mod", std::string());
		const bool hide = j.value("hide", true);
		const Door* first = nullptr;
		for (const auto& d : kDoors)
			if (mod == d.mod && d.hideable && SpellOf(d)) {
				first = &d;
				break;
			}
		if (!first)
			return Refuse("power", "That mod has no power the deck can hide");
		const bool saved = SetHidden(mod, hide);
		for (const auto& d : kDoors)
			if (mod == d.mod)
				ApplyPower(d, hide);
		const std::string who = first->modName;
		return Dump(json{ { "ok", saved }, { "op", "power" }, { "mod", mod }, { "hidden", hide },
			{ "msg", !saved ? std::string("Could not save the setting (interact.json)")
				: hide ? who + "'s power is hidden - use it from the Interact popout instead"
				       : who + "'s power is back in your Magic menu" } });
	}

	void OnGameLoaded()
	{
		ApplyAllHides();
	}
}
