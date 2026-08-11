#include "follower_tune.h"

#include <algorithm>
#include <string>
#include <unordered_set>
#include <vector>

#include "actor_identity.h"
#include "spell_actions.h"

// pch (force-included) provides RE::/SKSE::/json and `using namespace std::literals`.

using json = nlohmann::json;

namespace FollowerTune
{
	namespace
	{
		// Health is the one free-form number here, so it is the one that needs a
		// sane ceiling: a typo'd 100000 is not a follower, it is a wall.
		constexpr float kHealthMin = 1.0f;
		constexpr float kHealthMax = 20000.0f;
		constexpr std::size_t kMaxSpells = 32;
		constexpr std::size_t kMaxRows = 400;

		std::string Lower(std::string s)
		{
			std::transform(s.begin(), s.end(), s.begin(),
				[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			return s;
		}

		std::string PluginOf(const RE::TESForm* form)
		{
			if (!form)
				return "";
			auto* file = form->GetFile(0);
			return (file && file->fileName) ? std::string(file->fileName) : std::string();
		}

		std::string NameOf(RE::TESForm* form)
		{
			if (!form)
				return "";
			if (auto* full = form->As<RE::TESFullName>()) {
				if (const char* n = full->GetFullName(); n && *n)
					return n;
			}
			return "";
		}

		Record* Find(Config& c, const std::string& formId, const std::string& plugin)
		{
			const auto key = ActorIdentity::Key(formId, plugin);
			for (auto& r : c.rows)
				if (ActorIdentity::Key(r.formId, r.plugin) == key)
					return &r;
			return nullptr;
		}

		const Record* Find(const Config& c, const std::string& formId, const std::string& plugin)
		{
			return Find(const_cast<Config&>(c), formId, plugin);
		}

		Record& FindOrAdd(Config& c, const std::string& formId, const std::string& plugin,
			const std::string& name)
		{
			if (auto* hit = Find(c, formId, plugin)) {
				if (!name.empty())
					hit->name = name;
				return *hit;
			}
			Record r;
			r.formId = formId;
			r.plugin = plugin;
			r.name = name;
			c.rows.push_back(std::move(r));
			return c.rows.back();
		}

		// Drop a row that no longer asks for anything, so "reset her" really does
		// leave nothing behind rather than an empty row that reads as a rule.
		void PruneEmpty(Config& c)
		{
			c.rows.erase(std::remove_if(c.rows.begin(), c.rows.end(),
							 [](const Record& r) { return r.empty(); }),
				c.rows.end());
		}

		RE::SpellItem* SpellOf(const SpellRef& s)
		{
			auto* form = ActorIdentity::Resolve(s.formId, s.plugin);
			return form ? form->As<RE::SpellItem>() : nullptr;
		}

		// ---- the engine writes ------------------------------------------------
		// Each returns true when it CHANGED something, so Reapply can log honestly
		// rather than claiming to have fixed a follower who was already right.

		bool SetFlag(RE::Actor* actor, RE::ACTOR_BASE_DATA::Flag flag, bool on)
		{
			auto* base = actor ? actor->GetActorBase() : nullptr;
			if (!base)
				return false;
			const bool cur = base->actorData.actorBaseFlags.any(flag);
			if (cur == on)
				return false;
			if (on)
				base->actorData.actorBaseFlags.set(flag);
			else
				base->actorData.actorBaseFlags.reset(flag);
			return true;
		}

		bool SetPool(RE::Actor* actor, RE::ActorValue av, float want)
		{
			auto* avo = actor ? actor->AsActorValueOwner() : nullptr;
			if (!avo || want <= 0.0f)
				return false;
			const float cur = avo->GetPermanentActorValue(av);
			if (std::abs(cur - want) < 0.5f)
				return false;
			avo->SetBaseActorValue(av, want);
			/* Raising the POOL does not fill it: without this she walks around at
			   her old hit points inside a bigger bar, which reads as the setting
			   not having worked. Restore is clamped by the engine to the new
			   maximum, so over-restoring is the correct way to say "full". */
			avo->RestoreActorValue(RE::ACTOR_VALUE_MODIFIER::kDamage, av, want);
			return true;
		}

		// The three pools share one write. `which` is the record field AND the
		// engine value, so there is one table rather than three near-copies.
		RE::ActorValue AvOf(const std::string& which)
		{
			if (which == "magicka") return RE::ActorValue::kMagicka;
			if (which == "stamina") return RE::ActorValue::kStamina;
			return RE::ActorValue::kHealth;
		}

		float* AvSlot(Record& r, const std::string& which)
		{
			if (which == "magicka") return &r.magicka;
			if (which == "stamina") return &r.stamina;
			if (which == "health")  return &r.health;
			return nullptr;
		}

		RE::BGSPerk* PerkOf(const SpellRef& s)
		{
			auto* form = ActorIdentity::Resolve(s.formId, s.plugin);
			return form ? form->As<RE::BGSPerk>() : nullptr;
		}

		bool GivePerk(RE::Actor* actor, RE::BGSPerk* perk)
		{
			if (!actor || !perk || actor->HasPerk(perk))
				return false;
			actor->AddPerk(perk, 1);
			return true;
		}

		bool TakePerk(RE::Actor* actor, RE::BGSPerk* perk)
		{
			if (!actor || !perk || !actor->HasPerk(perk))
				return false;
			actor->RemovePerk(perk);
			return true;
		}

		bool GiveSpell(RE::Actor* actor, RE::SpellItem* spell)
		{
			if (!actor || !spell)
				return false;
			if (actor->HasSpell(spell))
				return false;
			actor->AddSpell(spell);
			return true;
		}

		bool TakeSpell(RE::Actor* actor, RE::SpellItem* spell)
		{
			if (!actor || !spell || !actor->HasSpell(spell))
				return false;
			actor->RemoveSpell(spell);
			return true;
		}

		// Apply one whole record to a live actor. Idempotent.
		int ApplyTo(const Record& r, RE::Actor* actor)
		{
			if (!actor)
				return 0;
			int n = 0;
			if (r.essential >= 0)
				n += SetFlag(actor, RE::ACTOR_BASE_DATA::Flag::kEssential, r.essential == 1) ? 1 : 0;
			if (r.protectedFlag >= 0)
				n += SetFlag(actor, RE::ACTOR_BASE_DATA::Flag::kProtected, r.protectedFlag == 1) ? 1 : 0;
			if (r.health > 0.0f)
				n += SetPool(actor, RE::ActorValue::kHealth, r.health) ? 1 : 0;
			if (r.magicka > 0.0f)
				n += SetPool(actor, RE::ActorValue::kMagicka, r.magicka) ? 1 : 0;
			if (r.stamina > 0.0f)
				n += SetPool(actor, RE::ActorValue::kStamina, r.stamina) ? 1 : 0;
			for (const auto& s : r.spells)
				n += GiveSpell(actor, SpellOf(s)) ? 1 : 0;
			for (const auto& p : r.perks)
				n += GivePerk(actor, PerkOf(p)) ? 1 : 0;
			return n;
		}

		json ReplyFor(const Config& c, RE::Actor* actor, bool ok, const std::string& msg)
		{
			json j;
			j["ok"] = ok;
			j["msg"] = msg;
			if (actor) {
				j["formId"] = ActorIdentity::HexOf(ActorIdentity::LocalIdOf(actor));
				j["tune"] = StateFor(c, actor);
			}
			return j;
		}
	}

	json ToJson(const Config& c)
	{
		json rows = json::array();
		for (const auto& r : c.rows) {
			json spells = json::array();
			for (const auto& s : r.spells)
				spells.push_back(json{ { "formId", s.formId }, { "plugin", s.plugin }, { "name", s.name } });
			json o{
				{ "formId", r.formId }, { "plugin", r.plugin }, { "name", r.name },
				{ "spells", spells },
			};
			// Absent means unset. Writing -1 would work too, but a config a human
			// opens should not need a legend to read.
			if (r.essential >= 0)
				o["essential"] = r.essential == 1;
			if (r.protectedFlag >= 0)
				o["protected"] = r.protectedFlag == 1;
			if (r.health > 0.0f)
				o["health"] = r.health;
			if (r.magicka > 0.0f)
				o["magicka"] = r.magicka;
			if (r.stamina > 0.0f)
				o["stamina"] = r.stamina;
			json perks = json::array();
			for (const auto& pk : r.perks)
				perks.push_back(json{ { "formId", pk.formId }, { "plugin", pk.plugin }, { "name", pk.name } });
			o["perks"] = perks;
			rows.push_back(std::move(o));
		}
		return json{ { "rows", rows } };
	}

	void FromJson(const json& j, Config& c)
	{
		c.rows.clear();
		if (!j.is_object() || !j.contains("rows") || !j["rows"].is_array())
			return;
		for (const auto& o : j["rows"]) {
			if (!o.is_object())
				continue;
			Record r;
			r.formId = o.value("formId", std::string(""));
			r.plugin = o.value("plugin", std::string(""));
			r.name = o.value("name", std::string(""));
			if (r.formId.empty())
				continue;
			if (o.contains("essential") && o["essential"].is_boolean())
				r.essential = o["essential"].get<bool>() ? 1 : 0;
			if (o.contains("protected") && o["protected"].is_boolean())
				r.protectedFlag = o["protected"].get<bool>() ? 1 : 0;
			if (o.contains("health") && o["health"].is_number())
				r.health = std::clamp(o["health"].get<float>(), 0.0f, kHealthMax);
			if (o.contains("magicka") && o["magicka"].is_number())
				r.magicka = std::clamp(o["magicka"].get<float>(), 0.0f, kHealthMax);
			if (o.contains("stamina") && o["stamina"].is_number())
				r.stamina = std::clamp(o["stamina"].get<float>(), 0.0f, kHealthMax);
			// Spells and perks are the same shape, so they parse through one lambda
			// rather than two copies that can drift.
			const auto refs = [&o](const char* key, std::vector<SpellRef>& out) {
				if (!o.contains(key) || !o[key].is_array())
					return;
				for (const auto& s : o[key]) {
					if (!s.is_object())
						continue;
					SpellRef sr;
					sr.formId = s.value("formId", std::string(""));
					sr.plugin = s.value("plugin", std::string(""));
					sr.name = s.value("name", std::string(""));
					if (!sr.formId.empty() && out.size() < kMaxSpells)
						out.push_back(std::move(sr));
				}
			};
			refs("spells", r.spells);
			refs("perks", r.perks);
			if (!r.empty() && c.rows.size() < kMaxRows)
				c.rows.push_back(std::move(r));
		}
	}

	json StateFor(const Config& c, RE::Actor* actor)
	{
		json j = json::object();
		if (!actor)
			return j;

		std::string formId, plugin;
		ActorIdentity::DurableOf(actor, formId, plugin);

		/* LIVE first — what the engine says right now. The card shows this and
		   not the remembered value, because the remembered value is a promise
		   and this is the fact. When they disagree the UI can say so. */
		json live = json::object();
		live["essential"] = actor->IsEssential();
		live["protected"] = actor->IsProtected();
		if (auto* avo = actor->AsActorValueOwner()) {
			// no std::max: the Windows max MACRO (leaked through the SKSE
			// headers) mangles it into a syntax error — C2589 on '::'. Same
			// trap, same fix as room_guard.cpp's box lambda (539f813).
			const auto floor0 = [](float v) { return v > 0.0f ? v : 0.0f; };
			const auto pool = [&](const char* key, RE::ActorValue av) {
				live[key] = static_cast<int>(floor0(avo->GetPermanentActorValue(av)));
				live[std::string(key) + "Now"] =
					static_cast<int>(floor0(avo->GetActorValue(av)));
			};
			pool("health", RE::ActorValue::kHealth);
			pool("magicka", RE::ActorValue::kMagicka);
			pool("stamina", RE::ActorValue::kStamina);
			live["level"] = static_cast<int>(actor->GetLevel());
		}
		j["live"] = live;
		j["durable"] = !formId.empty();

		const auto* r = formId.empty() ? nullptr : Find(c, formId, plugin);
		if (r) {
			json kept = json::object();
			if (r->essential >= 0)
				kept["essential"] = r->essential == 1;
			if (r->protectedFlag >= 0)
				kept["protected"] = r->protectedFlag == 1;
			if (r->health > 0.0f)
				kept["health"] = static_cast<int>(r->health);
			if (r->magicka > 0.0f)
				kept["magicka"] = static_cast<int>(r->magicka);
			if (r->stamina > 0.0f)
				kept["stamina"] = static_cast<int>(r->stamina);
			j["kept"] = kept;
		}

		/* Her spells: the ones WE gave her, each marked with whether she still
		   actually has it. A spell she has lost is the whole reason this module
		   re-applies, so the list must be able to show one. */
		json spells = json::array();
		if (r) {
			for (const auto& s : r->spells) {
				auto* sp = SpellOf(s);
				spells.push_back(json{
					{ "formId", s.formId }, { "plugin", s.plugin },
					{ "name", sp ? NameOf(sp) : s.name },
					{ "has", sp ? actor->HasSpell(sp) : false },
					{ "missing", sp == nullptr },
				});
			}
		}
		j["spells"] = spells;

		/* WHAT SHE CAN ACTUALLY CAST — her whole spell list, not just the ones
		   the deck handed her. Read straight off the actor the same way the
		   Spell Deck reads the player: the base record's SPLO list plus
		   everything learned at runtime. `given` marks ours, so the list
		   doubles as the answer to "did that share land?". */
		json known = json::array();
		{
			std::unordered_set<RE::FormID> seen;
			std::unordered_set<std::string> ours;
			if (r)
				for (const auto& s : r->spells)
					ours.insert(ActorIdentity::Key(s.formId, s.plugin));

			const auto add = [&](RE::SpellItem* sp) {
				if (!sp || !seen.insert(sp->GetFormID()).second)
					return;
				const auto nm = NameOf(sp);
				if (nm.empty())
					return;   // unnamed ability records are engine plumbing, not spells
				const auto local = ActorIdentity::HexOf(ActorIdentity::LocalIdOf(sp));
				known.push_back(json{
					{ "formId", local },
					{ "plugin", PluginOf(sp) },
					{ "name", nm },
					{ "given", ours.count(ActorIdentity::Key(local, PluginOf(sp))) > 0 },
				});
			};
			if (auto* base = actor->GetActorBase()) {
				if (auto* list = base->GetSpellList()) {
					if (list->spells)
						for (std::uint32_t i = 0; i < list->numSpells; ++i)
							add(list->spells[i]);
				}
			}
			for (auto* sp : actor->GetActorRuntimeData().addedSpells)
				add(sp);
		}
		j["known"] = known;

		/* Perks the deck granted, each with whether she still holds it — same
		   contract as the spells above, and the same reason: a perk stripped by
		   a framework reset is exactly what Reapply exists to put back. */
		json perks = json::array();
		if (r) {
			for (const auto& pk : r->perks) {
				auto* form = PerkOf(pk);
				perks.push_back(json{
					{ "formId", pk.formId }, { "plugin", pk.plugin },
					{ "name", form ? NameOf(form) : pk.name },
					{ "has", form ? actor->HasPerk(form) : false },
					{ "missing", form == nullptr },
				});
			}
		}
		j["perks"] = perks;
		return j;
	}

	json Apply(Config& c, const json& req, bool& changed)
	{
		changed = false;
		const auto op = req.value("op", std::string(""));
		const auto formId = req.value("formId", std::string(""));
		const auto plugin = req.value("plugin", std::string(""));

		auto* actor = ActorIdentity::ResolveActor(formId, plugin);
		if (!actor)
			return ReplyFor(c, nullptr, false, "Couldn't find that person in the game right now");

		std::string durId, durPlugin;
		if (!ActorIdentity::DurableOf(actor, durId, durPlugin)) {
			/* A spawned actor has no durable identity, so nothing about her can
			   be remembered. Say that instead of writing a row keyed on an id
			   that means someone else next session. */
			return ReplyFor(c, actor, false,
				std::string(NameOf(actor).empty() ? "She" : NameOf(actor)) +
					" was spawned this session — there is no id to remember her by");
		}
		const std::string who = NameOf(actor).empty() ? std::string("She") : NameOf(actor);

		if (op == "essential" || op == "protected") {
			const bool on = req.value("on", true);
			const bool ess = (op == "essential");
			auto& r = FindOrAdd(c, durId, durPlugin, NameOf(actor));
			(ess ? r.essential : r.protectedFlag) = on ? 1 : 0;
			/* Essential and protected are mutually exclusive in practice — the
			   engine checks essential first, so "protected" on an essential
			   actor is dead config. Clear the other one rather than store a
			   contradiction. */
			if (on) {
				if (ess && r.protectedFlag == 1)
					r.protectedFlag = 0;
				if (!ess && r.essential == 1)
					r.essential = 0;
			}
			SetFlag(actor, RE::ACTOR_BASE_DATA::Flag::kEssential, r.essential == 1);
			SetFlag(actor, RE::ACTOR_BASE_DATA::Flag::kProtected, r.protectedFlag == 1);
			PruneEmpty(c);
			changed = true;
			logger::info("tune: {} {} = {}", who, op, on ? "on" : "off");
			return ReplyFor(c, actor, true,
				who + (ess ? (on ? " cannot be killed" : " can be killed")
						   : (on ? " can only be killed by you" : " can be killed by anyone")));
		}

		/* One op for all three pools. `health` is still accepted as its own op
		   because a deployed view may still be sending it — a bridge that
		   silently stops answering an old name is how a control dies quietly. */
		if (op == "av" || op == "health") {
			const std::string which = (op == "health") ? "health"
													   : req.value("which", std::string("health"));
			const float want = std::clamp(req.value("value", 0.0f), 0.0f, kHealthMax);
			auto& r = FindOrAdd(c, durId, durPlugin, NameOf(actor));
			float* field = AvSlot(r, which);
			if (!field)
				return ReplyFor(c, actor, false, "Unknown pool '" + which + "'");
			if (want <= 0.0f) {
				*field = 0.0f;   // forget it; the engine keeps whatever it has
				PruneEmpty(c);
				changed = true;
				logger::info("tune: {} {} released", who, which);
				return ReplyFor(c, actor, true, which + " is hers to decide again");
			}
			*field = (want > kHealthMin) ? want : kHealthMin;  // not std::max: see above
			SetPool(actor, AvOf(which), *field);
			changed = true;
			logger::info("tune: {} {} = {:.0f}", who, which, *field);
			return ReplyFor(c, actor, true,
				who + " now has " + std::to_string(static_cast<int>(*field)) + " " + which);
		}

		if (op == "perkAdd" || op == "perkRemove") {
			const auto pid = req.value("perk", std::string(""));
			const auto pplugin = req.value("perkPlugin", std::string(""));
			auto* form = ActorIdentity::Resolve(pid, pplugin);
			auto* perk = form ? form->As<RE::BGSPerk>() : nullptr;
			if (!perk)
				return ReplyFor(c, actor, false, "That perk is not in this load order any more");
			const std::string pname = NameOf(perk);

			auto&      r = FindOrAdd(c, durId, durPlugin, NameOf(actor));
			const auto key = ActorIdentity::Key(pid, pplugin);
			auto       it = std::find_if(r.perks.begin(), r.perks.end(),
					  [&key](const SpellRef& x) { return ActorIdentity::Key(x.formId, x.plugin) == key; });

			if (op == "perkAdd") {
				if (r.perks.size() >= kMaxSpells)
					return ReplyFor(c, actor, false, "That is as many perks as the deck will remember");
				if (it == r.perks.end()) {
					SpellRef pr;
					pr.formId = pid;
					pr.plugin = pplugin;
					pr.name = pname;
					r.perks.push_back(std::move(pr));
				}
				GivePerk(actor, perk);
				changed = true;
				logger::info("tune: {} granted perk '{}'", who, pname);
				return ReplyFor(c, actor, true, who + " has " + pname);
			}

			if (it != r.perks.end())
				r.perks.erase(it);
			TakePerk(actor, perk);
			PruneEmpty(c);
			changed = true;
			logger::info("tune: {} lost perk '{}'", who, pname);
			return ReplyFor(c, actor, true, who + " no longer has " + pname);
		}

		if (op == "heal") {
			/* Deliberately NOT remembered: it is an action, not a setting. */
			if (auto* avo = actor->AsActorValueOwner()) {
				avo->RestoreActorValue(RE::ACTOR_VALUE_MODIFIER::kDamage, RE::ActorValue::kHealth, 100000.0f);
				avo->RestoreActorValue(RE::ACTOR_VALUE_MODIFIER::kDamage, RE::ActorValue::kMagicka, 100000.0f);
				avo->RestoreActorValue(RE::ACTOR_VALUE_MODIFIER::kDamage, RE::ActorValue::kStamina, 100000.0f);
			}
			return ReplyFor(c, actor, true, who + " is patched up");
		}

		if (op == "spellAdd" || op == "spellRemove") {
			const auto sid = req.value("spell", std::string(""));
			const auto splugin = req.value("spellPlugin", std::string(""));
			auto* form = ActorIdentity::Resolve(sid, splugin);
			auto* spell = form ? form->As<RE::SpellItem>() : nullptr;
			if (!spell)
				return ReplyFor(c, actor, false, "That spell is not in this load order any more");
			const std::string sname = NameOf(spell);

			auto& r = FindOrAdd(c, durId, durPlugin, NameOf(actor));
			const auto key = ActorIdentity::Key(sid, splugin);
			auto       it = std::find_if(r.spells.begin(), r.spells.end(),
					  [&key](const SpellRef& s) { return ActorIdentity::Key(s.formId, s.plugin) == key; });

			if (op == "spellAdd") {
				if (r.spells.size() >= kMaxSpells)
					return ReplyFor(c, actor, false, "That is as many spells as the deck will remember");
				if (it == r.spells.end()) {
					SpellRef sr;
					sr.formId = sid;
					sr.plugin = splugin;
					sr.name = sname;
					r.spells.push_back(std::move(sr));
				}
				GiveSpell(actor, spell);
				changed = true;
				logger::info("tune: {} taught '{}'", who, sname);
				return ReplyFor(c, actor, true, who + " knows " + sname);
			}

			if (it != r.spells.end())
				r.spells.erase(it);
			TakeSpell(actor, spell);
			PruneEmpty(c);
			changed = true;
			logger::info("tune: {} forgot '{}'", who, sname);
			return ReplyFor(c, actor, true, who + " no longer knows " + sname);
		}

		if (op == "clear") {
			auto* r = Find(c, durId, durPlugin);
			if (!r)
				return ReplyFor(c, actor, true, "Nothing was being remembered about " + who);
			/* Take back only what we GAVE. Her flags and her health are left
			   exactly as they are: the deck stops maintaining them, it does not
			   guess what they were before it started. */
			for (const auto& s : r->spells)
				TakeSpell(actor, SpellOf(s));
			for (const auto& pk : r->perks)
				TakePerk(actor, PerkOf(pk));
			const auto key = ActorIdentity::Key(durId, durPlugin);
			c.rows.erase(std::remove_if(c.rows.begin(), c.rows.end(),
							 [&key](const Record& x) { return ActorIdentity::Key(x.formId, x.plugin) == key; }),
				c.rows.end());
			changed = true;
			logger::info("tune: forgot everything for {}", who);
			return ReplyFor(c, actor, true, "The deck will stop managing " + who);
		}

		if (op == "state")
			return ReplyFor(c, actor, true, "");

		return ReplyFor(c, actor, false, "Unknown op '" + op + "'");
	}

	int Reapply(const Config& c)
	{
		int touched = 0;
		for (const auto& r : c.rows) {
			auto* actor = ActorIdentity::ResolveActor(r.formId, r.plugin);
			if (!actor || actor->IsDead())
				continue;
			const int n = ApplyTo(r, actor);
			if (n > 0) {
				++touched;
				logger::info("tune: re-applied {} setting(s) to {}", n,
					r.name.empty() ? r.formId : r.name);
			}
		}
		return touched;
	}

	json AllPerksJson()
	{
		json out = json::array();
		auto* dh = RE::TESDataHandler::GetSingleton();
		if (!dh)
			return out;
		std::vector<std::pair<std::string, RE::BGSPerk*>> rows;
		for (auto* pk : dh->GetFormArray<RE::BGSPerk>()) {
			if (!pk)
				continue;
			const auto nm = NameOf(pk);
			/* Unnamed perks are the engine's own plumbing (ability holders,
			   hidden entry points) — offering them would be offering nothing. */
			if (nm.empty())
				continue;
			rows.emplace_back(nm, pk);
		}
		std::sort(rows.begin(), rows.end(), [](const auto& a, const auto& b) {
			return Lower(a.first) < Lower(b.first);
		});
		for (const auto& [nm, pk] : rows) {
			out.push_back(json{
				{ "formId", ActorIdentity::HexOf(ActorIdentity::LocalIdOf(pk)) },
				{ "plugin", PluginOf(pk) },
				{ "name", nm },
			});
		}
		return out;
	}

	json PlayerSpellsJson()
	{
		auto j = json::parse(SpellActions::KnownSpellsJson(), nullptr, false);
		if (j.is_discarded() || !j.is_array())
			return json::array();
		/* The Spell Deck's list carries icon metadata this picker does not need,
		   but it also carries `slot` — and a SHOUT cannot be given to a follower
		   with AddSpell, so those are dropped here rather than offered and then
		   refused. */
		json out = json::array();
		for (const auto& s : j) {
			if (!s.is_object())
				continue;
			if (s.value("slot", std::string("hand")) != "hand")
				continue;
			out.push_back(json{
				{ "formId", ActorIdentity::HexOf(s.value("localId", 0u)) },
				{ "plugin", s.value("plugin", std::string("")) },
				{ "name", s.value("name", std::string("")) },
				{ "school", s.value("school", std::string("")) },
				{ "tier", s.value("tier", std::string("")) },
			});
		}
		return out;
	}
}
