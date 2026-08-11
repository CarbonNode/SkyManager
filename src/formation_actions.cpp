#include "formation_actions.h"

#include "npc_actions.h"  // TargetFormID(): the palette-open crosshair snapshot

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <string>
#include <vector>

// pch (force-included) provides RE::/SKSE::/json and the logger.

// wingdi.h #defines GetObject; Variable.h undefines it for itself but the
// macro is back by the time this file is parsed (same note as nff_bridge).
#ifdef GetObject
#	undef GetObject
#endif

using json = nlohmann::json;

namespace FormationActions
{
	namespace
	{
		constexpr const char* kPlugin = "FormationWithFollowers.esp";
		constexpr std::uint32_t kCoreQuest = 0x800;  // FWF_qstCore
		constexpr const char* kCoreClass = "FWF_scrCore";
		constexpr const char* kAliasClass = "FWF_scrFollowerAlias";

		// marker: formation-modal (deck bridge for Formation with Followers)

		bool g_loggedOk = false;

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

		RE::TESQuest* CoreQuest()
		{
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh)
				return nullptr;
			if (auto* f = dh->LookupForm(kCoreQuest, kPlugin))
				return f->As<RE::TESQuest>();
			return nullptr;
		}

		// Bind a form's instance of the named script — as declared, then
		// lowercased (Papyrus is case-insensitive, VM registration is not).
		RE::BSTSmartPointer<RE::BSScript::Object> BindForm(RE::TESForm* form, const char* cls)
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

		// An alias is not a form: its VM handle comes off the alias type id.
		RE::VMHandle AliasHandle(RE::BGSBaseAlias* alias)
		{
			auto* vm = Vm();
			auto* policy = vm ? vm->GetObjectHandlePolicy() : nullptr;
			if (!alias || !policy)
				return 0;
			return policy->GetHandleForObject(RE::BGSBaseAlias::VMTYPEID, alias);
		}

		RE::BSTSmartPointer<RE::BSScript::Object> BindAlias(RE::BGSBaseAlias* alias)
		{
			RE::BSTSmartPointer<RE::BSScript::Object> obj;
			auto*                                     vm = Vm();
			if (!vm)
				return obj;
			const auto handle = AliasHandle(alias);
			if (!handle)
				return obj;
			if (vm->FindBoundObject(handle, kAliasClass, obj) && obj)
				return obj;
			obj.reset();
			if (vm->FindBoundObject(handle, Lower(kAliasClass).c_str(), obj) && obj)
				return obj;
			obj.reset();
			return obj;
		}

		// Property access — GetProperty for an Auto property, with the raw
		// "::name_var" backing variable as the fallback (same as nff_bridge).
		const RE::BSScript::Variable* Prop(const RE::BSScript::Object* obj, const char* name)
		{
			if (!obj || !name)
				return nullptr;
			if (const auto* v = obj->GetProperty(name))
				return v;
			const std::string backing = std::string("::") + name + "_var";
			return obj->GetVariable(backing);
		}

		RE::BSScript::Variable* PropMut(RE::BSScript::Object* obj, const char* name)
		{
			if (!obj || !name)
				return nullptr;
			if (auto* v = obj->GetProperty(name))
				return v;
			const std::string backing = std::string("::") + name + "_var";
			return obj->GetVariable(backing);
		}

		// Typed reads gate on the variable's own type flag: Variable::Get*()
		// reinterprets a union and the asserts are gone in a release build.
		double VarFloat(const RE::BSScript::Variable* v, double fallback)
		{
			if (!v)
				return fallback;
			if (v->IsFloat())
				return static_cast<double>(v->GetFloat());
			if (v->IsInt())
				return static_cast<double>(v->GetSInt());
			return fallback;
		}

		bool VarBool(const RE::BSScript::Variable* v, bool fallback)
		{
			return (v && v->IsBool()) ? v->GetBool() : fallback;
		}

		int VarInt(const RE::BSScript::Variable* v, int fallback)
		{
			return (v && v->IsInt()) ? static_cast<int>(v->GetSInt()) : fallback;
		}

		// Typed writes refuse a type mismatch rather than reinterpreting the
		// union the other way — a missing property is a no-op, not a corruption.
		bool SetFloatProp(RE::BSScript::Object* obj, const char* name, double val)
		{
			auto* v = PropMut(obj, name);
			if (!v || !v->IsFloat())
				return false;
			v->SetFloat(static_cast<float>(val));
			return true;
		}

		bool SetBoolProp(RE::BSScript::Object* obj, const char* name, bool val)
		{
			auto* v = PropMut(obj, name);
			if (!v || !v->IsBool())
				return false;
			v->SetBool(val);
			return true;
		}

		// --------------------------------------------------- dispatching ----

		bool CallCore(RE::TESQuest* quest, const char* fn)
		{
			auto* vm = Vm();
			auto* policy = vm ? vm->GetObjectHandlePolicy() : nullptr;
			if (!vm || !policy || !quest || !fn)
				return false;
			const auto handle = policy->GetHandleForObject(RE::TESQuest::FORMTYPE, quest);
			if (handle == policy->EmptyHandle())
				return false;
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			auto args = RE::MakeFunctionArguments();
			return vm->DispatchMethodCall(handle, kCoreClass, fn, args, cb);
		}

		bool CallCoreActor(RE::TESQuest* quest, const char* fn, RE::Actor* actor)
		{
			auto* vm = Vm();
			auto* policy = vm ? vm->GetObjectHandlePolicy() : nullptr;
			if (!vm || !policy || !quest || !fn || !actor)
				return false;
			const auto handle = policy->GetHandleForObject(RE::TESQuest::FORMTYPE, quest);
			if (handle == policy->EmptyHandle())
				return false;
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			auto args = RE::MakeFunctionArguments(std::move(actor));
			return vm->DispatchMethodCall(handle, kCoreClass, fn, args, cb);
		}

		bool CallCoreActorInt(RE::TESQuest* quest, const char* fn, RE::Actor* actor, std::int32_t i)
		{
			auto* vm = Vm();
			auto* policy = vm ? vm->GetObjectHandlePolicy() : nullptr;
			if (!vm || !policy || !quest || !fn || !actor)
				return false;
			const auto handle = policy->GetHandleForObject(RE::TESQuest::FORMTYPE, quest);
			if (handle == policy->EmptyHandle())
				return false;
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			auto args = RE::MakeFunctionArguments(std::move(actor), std::move(i));
			return vm->DispatchMethodCall(handle, kCoreClass, fn, args, cb);
		}

		bool CallCoreBool(RE::TESQuest* quest, const char* fn, bool b)
		{
			auto* vm = Vm();
			auto* policy = vm ? vm->GetObjectHandlePolicy() : nullptr;
			if (!vm || !policy || !quest || !fn)
				return false;
			const auto handle = policy->GetHandleForObject(RE::TESQuest::FORMTYPE, quest);
			if (handle == policy->EmptyHandle())
				return false;
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			auto args = RE::MakeFunctionArguments(std::move(b));
			return vm->DispatchMethodCall(handle, kCoreClass, fn, args, cb);
		}

		bool CallCoreInt(RE::TESQuest* quest, const char* fn, std::int32_t i)
		{
			auto* vm = Vm();
			auto* policy = vm ? vm->GetObjectHandlePolicy() : nullptr;
			if (!vm || !policy || !quest || !fn)
				return false;
			const auto handle = policy->GetHandleForObject(RE::TESQuest::FORMTYPE, quest);
			if (handle == policy->EmptyHandle())
				return false;
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			auto args = RE::MakeFunctionArguments(std::move(i));
			return vm->DispatchMethodCall(handle, kCoreClass, fn, args, cb);
		}

		bool CallAlias(RE::BGSBaseAlias* alias, const char* fn)
		{
			auto* vm = Vm();
			if (!vm || !alias || !fn)
				return false;
			const auto handle = AliasHandle(alias);
			if (!handle)
				return false;
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			auto args = RE::MakeFunctionArguments();
			return vm->DispatchMethodCall(handle, kAliasClass, fn, args, cb);
		}

		// ------------------------------------------------------- aliases ----

		bool IsFollowerAlias(const RE::BGSBaseAlias* alias)
		{
			if (!alias)
				return false;
			const auto name = alias->aliasName;
			return name.size() >= 9 &&
			       _strnicmp(name.c_str(), "Follower", 8) == 0;
		}

		RE::Actor* AliasActor(RE::BGSBaseAlias* alias)
		{
			auto* ref = skyrim_cast<RE::BGSRefAlias*>(alias);
			if (!ref)
				return nullptr;
			auto* obj = ref->GetReference();
			return obj ? obj->As<RE::Actor>() : nullptr;
		}

		struct Slot
		{
			RE::BGSBaseAlias* alias = nullptr;
			RE::Actor*        actor = nullptr;  // null = empty slot
		};

		std::vector<Slot> FollowerSlots(RE::TESQuest* quest)
		{
			std::vector<Slot> out;
			if (!quest)
				return out;
			for (auto* alias : quest->aliases) {
				if (!IsFollowerAlias(alias))
					continue;
				out.push_back({ alias, AliasActor(alias) });
			}
			return out;
		}

		// ------------------------------------------------------- subject ----

		RE::Actor* ResolveSubject(const json& j)
		{
			const auto fid = j.value("formId", std::string(""));
			if (!fid.empty()) {
				const auto local =
					static_cast<std::uint32_t>(std::strtoul(fid.c_str(), nullptr, 16));
				if (local) {
					const auto plugin = j.value("plugin", std::string(""));
					if (!plugin.empty()) {
						if (auto* dh = RE::TESDataHandler::GetSingleton())
							if (auto* f = dh->LookupForm(local, plugin))
								return f->As<RE::Actor>();
					}
					if (auto* f = RE::TESForm::LookupByID(local))
						return f->As<RE::Actor>();
				}
			}
			if (const auto id = NpcActions::TargetFormID())
				return RE::TESForm::LookupByID<RE::Actor>(id);
			return nullptr;
		}

		std::string NameOf(RE::Actor* actor)
		{
			if (!actor)
				return "";
			const char* n = actor->GetDisplayFullName();
			return n ? n : "";
		}

		std::string HexOf(std::uint32_t id)
		{
			char buf[16]{};
			std::snprintf(buf, sizeof(buf), "0x%08X", id);
			return buf;
		}

		json Ok(const std::string& msg)
		{
			return json{ { "ok", true }, { "msg", msg } };
		}

		json Refuse(const std::string& msg)
		{
			return json{ { "ok", false }, { "msg", msg } };
		}
	}

	// ------------------------------------------------------------- state ----

	std::string StateJson(const std::string& reqJson)
	{
		auto j = json::parse(reqJson, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			j = json::object();

		json out{ { "present", false } };
		auto* quest = CoreQuest();
		if (!quest) {
			// Two different absences, said apart: plugin not in the load
			// order at all vs. present but its core quest unresolvable.
			auto* dh = RE::TESDataHandler::GetSingleton();
			out["installed"] = dh && dh->LookupModByName(kPlugin) != nullptr;
			return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
		out["present"] = true;
		out["installed"] = true;
		out["running"] = quest->IsRunning();

		auto core = BindForm(quest, kCoreClass);
		if (!core) {
			// ESP loaded but the script never bound (quest never initialized
			// — the mod starts itself on a new game only). Honest state; the
			// view offers nothing but the explanation.
			out["bound"] = false;
			return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
		out["bound"] = true;

		// The patched fork marks itself; driving the UNPATCHED save-poisoner
		// is something the modal warns about rather than hides.
		out["fixed"] = Prop(core.get(), "booDeckFixed") != nullptr;

		out["global"] = json{
			{ "enabled", !VarBool(Prop(core.get(), "booReleased"), false) },
			{ "interval", VarFloat(Prop(core.get(), "fltInterval"), 5.0) },
			{ "defaultX", VarFloat(Prop(core.get(), "fltDefaultX"), 128.0) },
			{ "defaultY", VarFloat(Prop(core.get(), "fltDefaultY"), 128.0) },
			{ "walkingArea", VarFloat(Prop(core.get(), "fltWalkingArea"), 64.0) },
			{ "stopArea", VarFloat(Prop(core.get(), "fltStopArea"), 16.0) },
			{ "habitation", VarBool(Prop(core.get(), "booEnabledInHabitation"), true) },
			{ "dungeon", VarBool(Prop(core.get(), "booEnabledInDungeon"), false) },
			{ "hotkey", VarInt(Prop(core.get(), "intHotkey"), -1) },
			{ "useQuickMenu", VarBool(Prop(core.get(), "booUseQuickMenu"), true) },
		};

		const auto slots = FollowerSlots(quest);
		int count = 0;
		for (const auto& s : slots)
			if (s.actor)
				++count;
		out["count"] = count;
		out["max"] = static_cast<int>(slots.size());

		// The card's subject, if she resolves: registration + her offsets.
		if (auto* subject = ResolveSubject(j)) {
			json sub{
				{ "formId", HexOf(subject->GetFormID()) },
				{ "name", NameOf(subject) },
				{ "registered", false },
			};
			for (std::size_t i = 0; i < slots.size(); ++i) {
				if (slots[i].actor != subject)
					continue;
				sub["registered"] = true;
				sub["slot"] = static_cast<int>(i);
				if (auto obj = BindAlias(slots[i].alias)) {
					sub["enabled"] = VarBool(Prop(obj.get(), "booEnabled"), true);
					sub["followX"] = VarFloat(Prop(obj.get(), "fltOffsetFollowX"), 0.0);
					sub["followY"] = VarFloat(Prop(obj.get(), "fltOffsetFollowY"), 0.0);
					sub["sneakX"] = VarFloat(Prop(obj.get(), "fltOffsetSneakX"), 0.0);
					sub["sneakY"] = VarFloat(Prop(obj.get(), "fltOffsetSneakY"), 0.0);
					sub["combatX"] = VarFloat(Prop(obj.get(), "fltOffsetCombatX"), 0.0);
					sub["combatY"] = VarFloat(Prop(obj.get(), "fltOffsetCombatY"), 0.0);
				}
				break;
			}
			// Teammate gate mirrors the mod's own SetAlias refusal, so the
			// modal can grey Register with the reason instead of a dead click.
			sub["teammate"] = subject->IsPlayerTeammate();
			out["subject"] = sub;
		}

		if (!g_loggedOk) {
			g_loggedOk = true;
			logger::info("Formation: {} bound (fixed={}, {} in formation)",
				kPlugin, out["fixed"].get<bool>(), count);
		}
		return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	// ------------------------------------------------------------- apply ----

	std::string Apply(const std::string& reqJson)
	{
		auto j = json::parse(reqJson, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return Refuse("Bad request").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

		auto* quest = CoreQuest();
		auto  core = BindForm(quest, kCoreClass);
		if (!quest || !core)
			return Refuse("Formation with Followers isn’t loaded").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

		bool touched = false;
		bool enabledNow = !VarBool(Prop(core.get(), "booReleased"), false);

		if (j.contains("global") && j["global"].is_object()) {
			const auto& g = j["global"];
			if (g.contains("enabled") && g["enabled"].is_boolean()) {
				enabledNow = g["enabled"].get<bool>();
				touched |= SetBoolProp(core.get(), "booReleased", !enabledNow);
			}
			// The mod's own MCM floor is 1s; below that the update loop is
			// exactly the overload that poisoned saves, so the deck clamps.
			if (g.contains("interval"))
				touched |= SetFloatProp(core.get(), "fltInterval",
					std::clamp(g.value("interval", 5.0), 1.0, 60.0));
			if (g.contains("defaultX"))
				touched |= SetFloatProp(core.get(), "fltDefaultX",
					std::clamp(g.value("defaultX", 128.0), 0.0, 1024.0));
			if (g.contains("defaultY"))
				touched |= SetFloatProp(core.get(), "fltDefaultY",
					std::clamp(g.value("defaultY", 128.0), 0.0, 1024.0));
			if (g.contains("walkingArea"))
				touched |= SetFloatProp(core.get(), "fltWalkingArea",
					std::clamp(g.value("walkingArea", 64.0), 0.0, 256.0));
			if (g.contains("stopArea"))
				touched |= SetFloatProp(core.get(), "fltStopArea",
					std::clamp(g.value("stopArea", 16.0), 0.0, 256.0));
			if (g.contains("habitation") && g["habitation"].is_boolean())
				touched |= SetBoolProp(core.get(), "booEnabledInHabitation",
					g["habitation"].get<bool>());
			if (g.contains("dungeon") && g["dungeon"].is_boolean())
				touched |= SetBoolProp(core.get(), "booEnabledInDungeon",
					g["dungeon"].get<bool>());
			if (g.contains("useQuickMenu") && g["useQuickMenu"].is_boolean())
				touched |= SetBoolProp(core.get(), "booUseQuickMenu",
					g["useQuickMenu"].get<bool>());
			// The cast key: RegisterHotkey rebinds AND unmaps the old code —
			// setting intHotkey alone leaves the old key still firing, which is
			// why the mod exposes a function rather than a plain property.
			// -1 = unbind (its own "no key" sentinel).
			if (g.contains("hotkey") && g["hotkey"].is_number_integer()) {
				if (CallCoreInt(quest, "RegisterHotkey", g["hotkey"].get<int>()))
					touched = true;
			}
		}

		if (j.contains("offsets") && j["offsets"].is_object()) {
			auto* subject = ResolveSubject(j);
			if (!subject)
				return Refuse("No one to set offsets for").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			RE::BGSBaseAlias* holder = nullptr;
			for (const auto& s : FollowerSlots(quest)) {
				if (s.actor == subject) {
					holder = s.alias;
					break;
				}
			}
			auto obj = holder ? BindAlias(holder)
			                  : RE::BSTSmartPointer<RE::BSScript::Object>{};
			if (!obj)
				return Refuse(NameOf(subject) + " isn’t in the formation yet").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			const auto& o = j["offsets"];
			if (o.contains("enabled") && o["enabled"].is_boolean())
				touched |= SetBoolProp(obj.get(), "booEnabled", o["enabled"].get<bool>());
			auto off = [&](const char* key, const char* prop) {
				if (o.contains(key))
					touched |= SetFloatProp(obj.get(), prop,
						std::clamp(o.value(key, 0.0), -1024.0, 1024.0));
			};
			off("followX", "fltOffsetFollowX");
			off("followY", "fltOffsetFollowY");
			off("sneakX", "fltOffsetSneakX");
			off("sneakY", "fltOffsetSneakY");
			off("combatX", "fltOffsetCombatX");
			off("combatY", "fltOffsetCombatY");
		}

		// Turning formation ON when the whole MOD was switched off (its quest
		// stopped via the MCM "Mod enabled" toggle / Termination) can't just
		// flip booReleased — the update engine isn't running. Start the mod
		// first, the way its own MCM does, restoring the saved config (JSON).
		// booReleased persists in the save, so clear it again after the restart
		// in case Initialization re-read a released state.
		bool started = false;
		if (enabledNow && !quest->IsRunning()) {
			started = CallCoreBool(quest, "Initialization", true);
			SetBoolProp(core.get(), "booReleased", false);
		}

		// The mod's own apply step. Release uses its dedicated teardown so
		// every follower's KeepOffset is actually cleared, not just ignored.
		// marker: formation-apply
		const bool sent = enabledNow ? CallCore(quest, "EvaluateAllFormation")
		                             : CallCore(quest, "ReleaseAllFormation");
		if (!sent && !started)
			return Refuse("Couldn’t reach the formation scripts").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		return Ok(started ? "Formation turned on"
		                  : (touched ? "Formation updated" : "Formation refreshed"))
			.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	// ---------------------------------------------------- register/clear ----

	std::string Reg(const std::string& reqJson)
	{
		auto j = json::parse(reqJson, nullptr, false);
		if (j.is_discarded() || !j.is_object())
			return Refuse("Bad request").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

		auto* quest = CoreQuest();
		if (!quest || !BindForm(quest, kCoreClass))
			return Refuse("Formation with Followers isn’t loaded").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		auto* subject = ResolveSubject(j);
		if (!subject)
			return Refuse("No one under the crosshair to register").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

		const auto op = j.value("op", std::string(""));
		if (op == "register") {
			if (!subject->IsPlayerTeammate())
				return Refuse(NameOf(subject) +
					" isn’t following you — the mod only forms up teammates").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			if (!CallCoreActorInt(quest, "SetAlias", subject, -1))
				return Refuse("Couldn’t reach the formation scripts").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			return Ok(NameOf(subject) + " joins the formation").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
		if (op == "unregister") {
			if (!CallCoreActor(quest, "ClearAlias", subject))
				return Refuse("Couldn’t reach the formation scripts").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			return Ok(NameOf(subject) + " leaves the formation").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}
		return Refuse("Unknown op").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	// ------------------------------------------------------------ rescue ----

	std::string Rescue()
	{
		auto* quest = CoreQuest();
		auto  core = BindForm(quest, kCoreClass);
		if (!quest || !core)
			return Refuse("Formation with Followers isn’t loaded").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

		// marker: formation-rescue
		if (Prop(core.get(), "booDeckFixed") != nullptr) {
			if (!CallCore(quest, "FWF_Rescue"))
				return Refuse("Couldn’t reach the formation scripts").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
			return Ok("Formation stood down — safe to save").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		// Unpatched scripts: UnregisterKeepOffset per alias FIRST (it is not
		// overridden in the Busy state, so it works on wedged aliases and
		// kills the repeating update + LOS registrations), then the mod's own
		// per-actor ClearAlias, then Termination for the power/quest teardown.
		int swept = 0;
		for (const auto& s : FollowerSlots(quest)) {
			if (!s.alias)
				continue;
			CallAlias(s.alias, "UnregisterKeepOffset");
			if (s.actor) {
				CallCoreActor(quest, "ClearAlias", s.actor);
				++swept;
			}
		}
		CallCore(quest, "Termination");
		logger::info("Formation: rescue swept {} follower(s) on the UNPATCHED scripts", swept);
		return Ok("Formation stood down (" + std::to_string(swept) +
			" swept) — save in a quiet spot to bank it").dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}
}
