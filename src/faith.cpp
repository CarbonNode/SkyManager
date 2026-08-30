#include "faith.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <string>
#include <vector>

// pch (force-included via set_pcxxheader) provides RE::/SKSE::/json and logger.
// Including it explicitly here defines the SKSE PCH twice and the translation
// unit fails with "class template has already been defined".

// wingdi.h (via Windows.h, pulled in by SKSE) #defines GetObject to GetObjectA,
// so `variable->GetObject()` compiles as `GetObjectA()` and fails to resolve.
// RE/V/Variable.h undefines it for its own declaration, but Windows.h is
// re-included after that, so the macro is back by the time this file is parsed.
// Same fix fertility_bridge.cpp / nff_bridge.cpp carry, for the same reason.
#ifdef GetObject
#	undef GetObject
#endif

using namespace std::literals;

namespace Faith
{
	using json = nlohmann::json;

	namespace
	{
		// Wintersun's own class name, as declared in its source:
		//   ScriptName WSN_TrackerQuest_Quest Extends Quest
		constexpr const char* kTrackerScript = "WSN_TrackerQuest_Quest";

		RE::TESQuest* g_quest = nullptr;
		bool          g_scanned = false;
		bool          g_saidPresent = false;

		// -------------------------------------------------------- vm idioms --
		// Local copies of the house idioms (fertility_bridge.cpp) — each deck
		// module carries its own so none grows a dependency on another's
		// internals.

		RE::BSScript::Internal::VirtualMachine* Vm()
		{
			return RE::BSScript::Internal::VirtualMachine::GetSingleton();
		}

		std::string Lower(std::string s)
		{
			std::transform(s.begin(), s.end(), s.begin(),
				[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			return s;
		}

		// Bind `form`'s instance of the named Papyrus script, or nullptr. Both
		// casings are tried: Papyrus is case-insensitive and toolchains register
		// the type differently, and the failure mode of guessing wrong here is
		// "the feature silently does not exist".
		RE::BSTSmartPointer<RE::BSScript::Object> BindScript(RE::TESForm* form, const char* cls)
		{
			RE::BSTSmartPointer<RE::BSScript::Object> obj;
			auto*                                     vm = Vm();
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

		// Each accessor gates on the variable's own type flag first: Variable's
		// getters reinterpret a union, so calling the wrong one in a release
		// build reads garbage rather than asserting.

		int VarInt(const RE::BSScript::Variable* v, int fallback = 0)
		{
			if (!v)
				return fallback;
			if (v->IsInt())
				return static_cast<int>(v->GetSInt());
			if (v->IsFloat())
				return static_cast<int>(v->GetFloat());
			return fallback;
		}

		float VarFloat(const RE::BSScript::Variable* v, float fallback = 0.0f)
		{
			if (!v)
				return fallback;
			if (v->IsFloat())
				return v->GetFloat();
			if (v->IsInt())
				return static_cast<float>(v->GetSInt());
			return fallback;
		}

		bool VarBool(const RE::BSScript::Variable* v, bool fallback = false)
		{
			if (!v || !v->IsBool())
				return fallback;
			return v->GetBool();
		}

		std::string VarString(const RE::BSScript::Variable* v)
		{
			if (!v || !v->IsString())
				return std::string();
			return std::string(v->GetString());
		}

		RE::TESForm* VarForm(const RE::BSScript::Variable* v, RE::FormType type)
		{
			if (!v || !v->IsObject() || v->IsNoneObject())
				return nullptr;
			auto obj = v->GetObject();
			if (!obj)
				return nullptr;
			auto* vm = Vm();
			auto* policy = vm ? vm->GetObjectHandlePolicy() : nullptr;
			if (!policy)
				return nullptr;
			const auto handle = obj->GetHandle();
			if (handle == policy->EmptyHandle() || !policy->HandleIsType(type, handle))
				return nullptr;
			return policy->GetObjectForHandle(type, handle);
		}

		RE::BSTSmartPointer<RE::BSScript::Array> PropArray(RE::BSScript::Object* obj, const char* name)
		{
			RE::BSTSmartPointer<RE::BSScript::Array> arr;
			const auto*                              v = Prop(obj, name);
			if (!v || !v->IsArray())
				return arr;
			return v->GetArray();
		}

		// One element of an array property, bounds-checked. Wintersun's per-deity
		// arrays are parallel but not all the same length (a table that grew a
		// column later is shorter), so every read is independently checked rather
		// than trusting WorshipID to be valid everywhere.
		const RE::BSScript::Variable* ArrayAt(RE::BSScript::Object* obj, const char* name, int index)
		{
			if (index < 0)
				return nullptr;
			auto arr = PropArray(obj, name);
			if (!arr)
				return nullptr;
			const auto n = static_cast<int>(arr->size());
			if (index >= n)
				return nullptr;
			return &(*arr)[static_cast<std::uint32_t>(index)];
		}

		RE::SpellItem* SpellAt(RE::BSScript::Object* obj, const char* name, int index)
		{
			auto* form = VarForm(ArrayAt(obj, name, index), RE::FormType::Spell);
			return form ? form->As<RE::SpellItem>() : nullptr;
		}

		// A GlobalVariable reached through one of Wintersun's OWN properties —
		// its pointer, not a name we typed, so the deck cannot read a different
		// global than the mod writes. `fallbackEdid` covers the one case that
		// leaves: a Wintersun build where the property was renamed.
		float GlobalOf(RE::BSScript::Object* obj, const char* prop, const char* fallbackEdid,
			float fallback = 0.0f)
		{
			if (auto* form = VarForm(Prop(obj, prop), RE::FormType::Global)) {
				if (auto* g = form->As<RE::TESGlobal>())
					return g->value;
			}
			if (fallbackEdid) {
				if (const auto* g = RE::TESForm::LookupByEditorID<RE::TESGlobal>(fallbackEdid))
					return g->value;
			}
			return fallback;
		}

		float GlobalAt(RE::BSScript::Object* obj, const char* name, int index, float fallback)
		{
			auto* form = VarForm(ArrayAt(obj, name, index), RE::FormType::Global);
			if (auto* g = form ? form->As<RE::TESGlobal>() : nullptr)
				return g->value;
			return fallback;
		}

		// ------------------------------------------------------ descriptions --
		//
		// The bonus text is the point of the card, and it lives where the vanilla
		// item card reads it: each visible magic effect's DNAM, with <mag>/<dur>/
		// <area> filled from THIS spell's effect item. Same construction
		// spell_actions.cpp's hover description uses.
		//
		// Wintersun writes real prose there (its Tenets effect carries ~150 bytes
		// of it), so this yields the mod's own words rather than a summary we
		// invented. Hidden-in-UI effects are skipped first — they are plumbing —
		// but if that leaves nothing at all, they are read anyway rather than
		// showing a bonus with no explanation.
		void ReplaceTag(std::string& s, const char* tag, const std::string& value)
		{
			const std::string lowerTag = Lower(tag);
			for (;;) {
				const std::string lower = Lower(s);
				const auto        at = lower.find(lowerTag);
				if (at == std::string::npos)
					return;
				s.replace(at, lowerTag.size(), value);
			}
		}

		std::string DescribeSpell(RE::SpellItem* spell, bool includeHidden)
		{
			std::string text;
			if (!spell)
				return text;
			for (auto* eff : spell->effects) {
				auto* base = eff ? eff->baseEffect : nullptr;
				if (!base)
					continue;
				if (!includeHidden &&
					base->data.flags.any(RE::EffectSetting::EffectSettingData::Flag::kHideInUI))
					continue;
				const char* raw = base->magicItemDescription.c_str();
				std::string t = raw ? raw : "";
				if (t.empty())
					continue;
				ReplaceTag(t, "<mag>", std::to_string(static_cast<long long>(std::llround(eff->effectItem.magnitude))));
				ReplaceTag(t, "<dur>", std::to_string(eff->effectItem.duration));
				ReplaceTag(t, "<area>", std::to_string(eff->effectItem.area));
				// A conditioned ability repeats the same sentence on several
				// effect slots (one per race/state branch); saying it twice reads
				// like a bug, so an exact repeat is dropped.
				if (text.find(t) != std::string::npos)
					continue;
				if (!text.empty() && text.back() != ' ')
					text += ' ';
				text += t;
			}
			return text;
		}

		std::string TextOf(RE::SpellItem* spell)
		{
			std::string text = DescribeSpell(spell, false);
			if (text.empty())
				text = DescribeSpell(spell, true);
			return text;
		}

		std::string NameOf(RE::TESForm* form)
		{
			if (!form)
				return std::string();
			const char* n = form->GetName();
			return (n && *n) ? std::string(n) : std::string();
		}

		// One row of the "what you get" list. `have` is the LIVE truth
		// (Actor::HasSpell), never inferred from the favour number: Boon 2 is
		// granted by Wintersun's own script, and a row that claimed otherwise
		// would be the deck disagreeing with the game.
		void PushEntry(json& arr, const char* slot, const char* label, RE::SpellItem* spell,
			RE::Actor* player, const std::string& note)
		{
			if (!spell)
				return;   // this god has no such boon in this build — omit, never fake
			json row{
				{ "slot", slot },
				{ "label", label },
				{ "name", NameOf(spell) },
				{ "text", TextOf(spell) },
			};
			if (player)
				row["have"] = player->HasSpell(spell);
			if (!note.empty())
				row["note"] = note;
			arr.push_back(std::move(row));
		}

		// Find the quest carrying Wintersun's tracker script. Cached: the scan
		// walks every quest in the load order, which is thousands of forms here.
		RE::TESQuest* TrackerQuest()
		{
			if (g_scanned)
				return g_quest;
			g_scanned = true;
			g_quest = nullptr;

			auto* handler = RE::TESDataHandler::GetSingleton();
			if (!handler)
				return nullptr;
			for (auto* quest : handler->GetFormArray<RE::TESQuest>()) {
				if (!quest)
					continue;
				if (BindScript(quest, kTrackerScript)) {
					g_quest = quest;
					break;
				}
			}
			return g_quest;
		}

		RE::BSTSmartPointer<RE::BSScript::Object> Tracker()
		{
			return BindScript(TrackerQuest(), kTrackerScript);
		}
	}

	void Invalidate()
	{
		g_scanned = false;
		g_quest = nullptr;
	}

	json BuildJson()
	{
		json out{ { "present", false }, { "active", false } };

		auto tracker = Tracker();
		if (!tracker)
			return out;   // Wintersun absent, or its quest has never started
		out["present"] = true;

		auto* obj = tracker.get();
		auto* player = RE::PlayerCharacter::GetSingleton();

		// Marker: "faith: Wintersun tracker bound" — hd-markers.json fingerprint.
		if (!g_saidPresent) {
			g_saidPresent = true;
			logger::info("faith: Wintersun tracker bound");
		}

		const int id = VarInt(Prop(obj, "WorshipID"), -1);
		if (id < 0)
			return out;   // Wintersun IS here and you follow no god — a real state
		out["active"] = true;

		const std::string deity = VarString(ArrayAt(obj, "WSN_DeityName", id));
		const std::string type = VarString(ArrayAt(obj, "WSN_DivineType", id));
		if (!deity.empty())
			out["deity"] = deity;
		if (!type.empty())
			out["pantheon"] = type;

		const float favor = GlobalOf(obj, "WSN_Favor_Global", "WSN_Favor_Global");
		out["favor"] = favor;

		// Thresholds are Wintersun's own properties, not constants of ours: a
		// build (or a patch) that retunes them retunes the meter with it. Sent
		// only when they read as sane, so the view never draws a bar against 0.
		const float threshold = VarFloat(Prop(obj, "WSN_ThresholdFavored"), 0.0f);
		const float target = VarFloat(Prop(obj, "WSN_FavoredDiminishTarget"), 0.0f);
		if (threshold > 0.0f)
			out["threshold"] = threshold;
		if (target > 0.0f)
			out["target"] = target;
		out["favored"] = VarBool(Prop(obj, "IsFavored"), threshold > 0.0f && favor >= threshold);

		// Favour reaching 0 is apostasy — the god drops you — unless the player
		// turned that off in Wintersun's MCM. Worth saying out loud on a meter
		// whose left end is not "nothing happens".
		out["apostasy"] = GlobalOf(obj, "WSN_Misc_Global_DisableAbandon",
							  "WSN_Misc_Global_DisableAbandon", 0.0f) == 0.0f;

		// Your race can be one this god favours (Wintersun multiplies every gain
		// when it is). Read as forms and compared to the player's race, so a
		// custom race that IS the favoured record still matches.
		if (player) {
			auto* race = player->GetRace();
			auto* fav0 = VarForm(ArrayAt(obj, "WSN_FavoredRace0", id), RE::FormType::Race);
			auto* fav1 = VarForm(ArrayAt(obj, "WSN_FavoredRace1", id), RE::FormType::Race);
			if (race && (race == fav0 || race == fav1)) {
				out["raceFavored"] = true;
				out["raceMult"] = GlobalOf(obj, "WSN_FavorFavoredRaceMult_Global",
					"WSN_FavorFavoredRaceMult_Global", 1.0f);
			}
		}

		// Favour per GAME DAY, exactly as Wintersun computes it. Its update fires
		// every WSN_UpdateRate game hours and each tick applies
		// (drain × time-since-last-tick in days), so the per-tick multipliers
		// cancel and the product below IS the daily figure. Deity-specific
		// situational modifiers (Molag Bal while a vampire, Hircine in beast
		// form…) are deliberately NOT folded in: they come and go, and a number
		// that changed as you transformed would read as broken.
		const int typeId = VarInt(ArrayAt(obj, "WSN_DivineTypeID", id), -1);
		const float drain = GlobalOf(obj, "WSN_FavorDrain_Global", "WSN_FavorDrain_Global") *
							GlobalAt(obj, "WSN_DrainRateMult", typeId, 1.0f) *
							VarFloat(ArrayAt(obj, "WSN_DrainRateMultIndividual", id), 1.0f) *
							GlobalOf(obj, "WSN_Misc_Global_DrainMult", "WSN_Misc_Global_DrainMult", 1.0f);
		if (drain != 0.0f)
			out["drainPerDay"] = drain;

		// What a prayer is worth. Wintersun scales it by the time since your last
		// one (capped at a day), so this is the CEILING — the view says so.
		const float prayerGain = GlobalOf(obj, "WSN_FavorMeditation_Global", "WSN_FavorMeditation_Global") *
								 GlobalAt(obj, "WSN_PrayerRateMult", typeId, 1.0f) *
								 VarFloat(ArrayAt(obj, "WSN_PrayerRateMultIndividual", id), 1.0f) *
								 GlobalOf(obj, "WSN_Misc_Global_MeditateMult", "WSN_Misc_Global_MeditateMult", 1.0f);
		if (prayerGain != 0.0f)
			out["prayerGain"] = prayerGain;

		json entries = json::array();
		PushEntry(entries, "boon1", "Boon", SpellAt(obj, "WSN_Boon1", id), player, "");
		{
			std::string note;
			if (threshold > 0.0f && favor < threshold)
				note = "granted at " + std::to_string(static_cast<long long>(std::llround(threshold))) +
					   " favour";
			PushEntry(entries, "boon2", "Favoured boon", SpellAt(obj, "WSN_Boon2", id), player, note);
		}
		PushEntry(entries, "blessing", "Altar blessing", SpellAt(obj, "WSN_Blessing", id), nullptr, "");
		PushEntry(entries, "tenets", "Tenets", SpellAt(obj, "WSN_Tenet", id), player, "");
		out["entries"] = std::move(entries);

		if (auto* form = VarForm(Prop(obj, "WSN_Prayer_Spell"), RE::FormType::Spell)) {
			if (auto* prayer = form->As<RE::SpellItem>()) {
				json p{ { "name", NameOf(prayer) } };
				if (player)
					p["have"] = player->HasSpell(prayer);
				out["prayer"] = std::move(p);
			}
		}

		return out;
	}
}
