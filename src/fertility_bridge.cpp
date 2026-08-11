#include "fertility_bridge.h"

#include "follower_deck.h"

#include <algorithm>
#include <cctype>
#include <cmath>
#include <string>

// pch (force-included via set_pcxxheader) provides RE::/SKSE::/json and logger.
// Including it explicitly here defines the SKSE PCH twice and the translation
// unit fails with "class template has already been defined".

// wingdi.h (via Windows.h, pulled in by SKSE) #defines GetObject to GetObjectA,
// so `variable->GetObject()` compiles as `GetObjectA()` and fails to resolve.
// RE/V/Variable.h undefines it for its own declaration, but Windows.h is
// re-included after that, so the macro is back by the time this file is parsed.
// Same fix nff_bridge.cpp carries, for the same reason.
#ifdef GetObject
#	undef GetObject
#endif

using namespace std::literals;

namespace FertilityBridge
{
	namespace
	{
		// The storage script's class name, as declared in FM's source:
		//   ScriptName _JSW_BB_Storage Extends Quest
		constexpr const char* kStorageScript = "_JSW_BB_Storage";

		// Vanilla GameDaysPassed, the clock FM's own MCM reads.
		constexpr RE::FormID kGameDaysPassed = 0x00000039;

		RE::TESQuest* g_storageQuest = nullptr;
		bool          g_scanned = false;

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
			if (!v || !v->IsInt())
				return fallback;
			return static_cast<int>(v->GetSInt());
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

		// The object held in a variable — used for FM's GVHolder, which is a
		// script instance reached through a property rather than a form we own.
		RE::BSTSmartPointer<RE::BSScript::Object> VarObject(const RE::BSScript::Variable* v)
		{
			RE::BSTSmartPointer<RE::BSScript::Object> obj;
			if (!v || !v->IsObject() || v->IsNoneObject())
				return obj;
			return v->GetObject();
		}

		RE::Actor* VarActor(const RE::BSScript::Variable* v)
		{
			auto* form = VarForm(v, RE::FormType::ActorCharacter);
			if (!form)
				form = VarForm(v, RE::FormType::Reference);
			return form ? form->As<RE::Actor>() : nullptr;
		}

		RE::BSTSmartPointer<RE::BSScript::Array> PropArray(RE::BSScript::Object* obj, const char* name)
		{
			RE::BSTSmartPointer<RE::BSScript::Array> arr;
			const auto*                              v = Prop(obj, name);
			if (!v || !v->IsArray())
				return arr;
			return v->GetArray();
		}

		// One element of an array property, bounds-checked. FM's arrays are
		// parallel but not guaranteed to be the same length after a compaction
		// pass, so every read is independently checked rather than assuming the
		// index from TrackedActors is valid everywhere.
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

		// Index of `actor` in a Form[] property, or -1. This is FM's own
		// GetActorIndex (TrackedActors.find) done without a Papyrus call.
		int FindForm(RE::BSScript::Object* obj, const char* name, RE::TESForm* needle)
		{
			if (!needle)
				return -1;
			auto arr = PropArray(obj, name);
			if (!arr)
				return -1;
			const auto n = arr->size();
			for (std::uint32_t i = 0; i < n; ++i) {
				const auto& element = (*arr)[i];
				if (VarForm(&element, RE::FormType::ActorCharacter) == needle ||
					VarForm(&element, RE::FormType::Reference) == needle) {
					return static_cast<int>(i);
				}
			}
			return -1;
		}

		// Find the quest carrying FM's storage script. Cached: the scan walks
		// every quest in the load order, which is thousands of forms here.
		RE::TESQuest* StorageQuest()
		{
			if (g_scanned)
				return g_storageQuest;
			g_scanned = true;
			g_storageQuest = nullptr;

			auto* handler = RE::TESDataHandler::GetSingleton();
			if (!handler)
				return nullptr;
			for (auto* quest : handler->GetFormArray<RE::TESQuest>()) {
				if (!quest)
					continue;
				if (BindScript(quest, kStorageScript)) {
					g_storageQuest = quest;
					break;
				}
			}
			return g_storageQuest;
		}

		RE::BSTSmartPointer<RE::BSScript::Object> Storage()
		{
			return BindScript(StorageQuest(), kStorageScript);
		}

		// FM's own settings holder (_JSW_SUB_GVHolderScript), reached through the
		// storage script's GVHolder property.
		RE::BSTSmartPointer<RE::BSScript::Object> Holder(RE::BSScript::Object* storage)
		{
			return VarObject(Prop(storage, "GVHolder"));
		}

		// The day clock. Read FM's OWN global (GVHolder.GVGameDaysPassed) rather
		// than looking up GameDaysPassed by form id: it is the exact value FM
		// compares against, so the deck cannot drift from FM's arithmetic, and
		// there is no hardcoded id to be wrong about. The vanilla global is only
		// a fallback for the case where the holder is unreadable.
		float GameDaysPassed(RE::BSScript::Object* storage)
		{
			if (auto holder = Holder(storage)) {
				auto* form = VarForm(Prop(holder.get(), "GVGameDaysPassed"), RE::FormType::Global);
				if (auto* global = form ? form->As<RE::TESGlobal>() : nullptr)
					return global->value;
			}
			if (auto* handler = RE::TESDataHandler::GetSingleton()) {
				auto* global = handler->LookupForm<RE::TESGlobal>(kGameDaysPassed, "Skyrim.esm");
				if (global)
					return global->value;
			}
			return 0.0f;
		}

		// Configurable in FM's MCM (default 30, floored at 12), so it must be
		// read rather than assumed — a hardcoded term would mis-report progress
		// on any save that changed it.
		int PregnancyDuration(RE::BSScript::Object* storage)
		{
			if (auto holder = Holder(storage)) {
				const int days = VarInt(Prop(holder.get(), "PregnancyDuration"), 0);
				if (days > 0)
					return days;
			}
			return 0;
		}
	}

	void Invalidate()
	{
		g_scanned = false;
		g_storageQuest = nullptr;
	}

	bool Available()
	{
		return static_cast<bool>(Storage());
	}

	Status For(RE::Actor* actor)
	{
		Status status;
		if (!actor)
			return status;

		auto storage = Storage();
		if (!storage)
			return status;   // Fertility Mode absent, or its quest not started
		status.available = true;

		auto* obj = storage.get();
		status.index = FindForm(obj, "TrackedActors", actor);
		if (status.index < 0)
			return status;   // untracked (male, excluded, or not yet seen)
		status.tracked = true;

		status.blocked = FindForm(obj, "ActorBlackList", actor) >= 0;

		// FM's rule, verbatim: pregnant iff a conception time is recorded.
		const float conception = VarFloat(ArrayAt(obj, "LastConception", status.index));
		status.pregnant = (conception != 0.0f);

		if (status.pregnant) {
			const float now = GameDaysPassed(obj);
			// Guard the clock: a save edited or loaded out of order can put
			// conception in the future, and a negative day reads as nonsense.
			const float elapsed = now - conception;
			status.pregnancyDay = elapsed > 0.0f ? static_cast<int>(elapsed) : 0;

			status.termDays = PregnancyDuration(obj);
			if (status.termDays > 0) {
				// FM's own progress formula (_JSW_BB_Utility): elapsed / term.
				const float fraction = elapsed / static_cast<float>(status.termDays);
				const int   percent = static_cast<int>(fraction * 100.0f);
				status.percent = percent < 0 ? 0 : (percent > 100 ? 100 : percent);
				// FM splits the term in three (FMValues[0] = duration / 3).
				const int third = status.termDays / 3;
				if (third > 0) {
					const int trimester = 1 + (status.pregnancyDay / third);
					status.trimester = trimester > 3 ? 3 : trimester;
				}
			}
		}

		if (auto* father = VarActor(ArrayAt(obj, "CurrentFatherForm", status.index))) {
			if (const char* name = father->GetDisplayFullName())
				status.father = name;
		}

		status.cycleDay = VarInt(ArrayAt(obj, "DayOfCycle", status.index));
		status.spermCount = VarInt(ArrayAt(obj, "SpermCount", status.index));
		status.timesDelivered = VarInt(ArrayAt(obj, "TimesDelivered", status.index));
		status.lastBirthDay = static_cast<int>(VarFloat(ArrayAt(obj, "LastBirth", status.index)));
		status.ovulating = VarFloat(ArrayAt(obj, "LastOvulation", status.index)) != 0.0f;

		return status;
	}

	nlohmann::json ToJson(const Status& status)
	{
		nlohmann::json out;
		out["available"] = status.available;
		out["tracked"] = status.tracked;
		if (!status.tracked)
			return out;

		out["index"] = status.index;
		out["blocked"] = status.blocked;
		out["pregnant"] = status.pregnant;
		if (status.pregnant) {
			out["day"] = status.pregnancyDay;
			if (status.termDays > 0) {
				out["termDays"] = status.termDays;
				out["percent"] = status.percent;
				out["daysLeft"] = status.termDays > status.pregnancyDay
					? status.termDays - status.pregnancyDay : 0;
			}
			if (status.trimester > 0)
				out["trimester"] = status.trimester;
			if (!status.father.empty())
				out["father"] = status.father;
		} else {
			out["cycleDay"] = status.cycleDay;
			out["spermCount"] = status.spermCount;
			out["ovulating"] = status.ovulating;
			if (!status.father.empty())
				out["potentialFather"] = status.father;
		}
		if (status.lastBirthDay > 0)
			out["lastBirthDay"] = status.lastBirthDay;
		if (status.timesDelivered > 0)
			out["births"] = status.timesDelivered;
		return out;
	}

	nlohmann::json JsonFor(RE::Actor* actor)
	{
		return ToJson(For(actor));
	}

	std::string StateJson(const std::string& foStateJson)
	{
		nlohmann::json out{
			{ "ok", true },
			{ "available", Available() },
			{ "actors", nlohmann::json::object() },
		};

		if (!out["available"].get<bool>())
			return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);   // FM absent: the pane renders exactly as before

		const auto env = nlohmann::json::parse(foStateJson, nullptr, false);
		if (env.is_discarded() || !env.is_object())
			return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		const nlohmann::json& state =
			env.contains("state") && env["state"].is_object() ? env["state"] : env;
		if (!state.contains("categories") || !state["categories"].is_array())
			return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);

		int tracked = 0;
		int pregnant = 0;
		for (const auto& cat : state["categories"]) {
			if (!cat.is_object() || !cat.contains("members") || !cat["members"].is_array())
				continue;
			for (const auto& member : cat["members"]) {
				if (!member.is_object())
					continue;
				const auto id = member.value("formId", std::string(""));
				if (id.empty() || out["actors"].contains(id))
					continue;

				RE::FormID formId = 0;
				try {
					formId = static_cast<RE::FormID>(std::stoul(id, nullptr, 16));
				} catch (const std::exception&) {
					continue;   // FO gave us something that is not a form id
				}
				auto* form = RE::TESForm::LookupByID(formId);
				auto* refr = form ? form->As<RE::TESObjectREFR>() : nullptr;
				auto* actor = refr ? refr->As<RE::Actor>() : nullptr;
				if (!actor)
					continue;   // unresolved member, or a base form: nothing to read

				const auto status = For(actor);
				if (!status.tracked)
					continue;   // keep the payload to the actors FM actually knows
				++tracked;
				if (status.pregnant)
					++pregnant;
				out["actors"][id] = ToJson(status);
			}
		}

		out["tracked"] = tracked;
		out["pregnant"] = pregnant;
		return out.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
	}

	std::string StateJson()
	{
		return StateJson(FollowerDeck::StateJson());
	}
}
