#include "chim_control.h"

#include <utility>

// pch (force-included) provides RE::/SKSE::/json and the logger.

// Windows.h (dragged in by the PCH) defines GetObject as a macro that expands
// to GetObjectA — which mangles RE::BSScript::Variable::GetObject() below into
// a member that does not exist (C2039 'GetObjectA'). Undo it locally; we want
// the real CommonLib method. Same wingdi.h collision that bites GetObject /
// PlaySound in every SKSE plugin that pulls in Windows.h.
#ifdef GetObject
#	undef GetObject
#endif

namespace ChimControl
{
	namespace
	{
		// CHIM's own global-function script. Its .pex ships with the CHIM
		// AIAgent mod and the AIAgent.dll registers these as natives, so in any
		// save where CHIM has run the type is already loaded; the VM binds it on
		// demand otherwise. The marker string "chim-activate" below is what the
		// build/deploy fingerprint checks for.
		constexpr const char* kScript = "AIAgentFunctions";

		RE::BSScript::Internal::VirtualMachine* Vm()
		{
			return RE::BSScript::Internal::VirtualMachine::GetSingleton();
		}

		RE::Actor* ResolveActor(std::uint32_t id)
		{
			auto* form = id ? RE::TESForm::LookupByID(static_cast<RE::FormID>(id)) : nullptr;
			auto* refr = form ? form->As<RE::TESObjectREFR>() : nullptr;
			return refr ? refr->As<RE::Actor>() : nullptr;
		}

		// getAgentByName returns an Actor; None => not a CHIM agent. The result
		// arrives on the VM's thread — hop it back to the main thread before it
		// touches the view, exactly like mhiyh_control's BoolResult.
		class ActorResult : public RE::BSScript::IStackCallbackFunctor
		{
		public:
			explicit ActorResult(StateCb then) :
				_then(std::move(then))
			{}

			void operator()(RE::BSScript::Variable a_result) override
			{
				// IsObject() first: Get*() reinterprets a union, and a function
				// that returned None must read as "not an agent", not a crash.
				const bool active = a_result.IsObject() && static_cast<bool>(a_result.GetObject());
				auto       then = _then;
				if (!then)
					return;
				if (auto* task = SKSE::GetTaskInterface())
					task->AddTask([then, active]() { then(active, true); });
			}

			bool CanSave() const override { return false; }
			void SetObject(const RE::BSTSmartPointer<RE::BSScript::Object>&) override {}

		private:
			StateCb _then;
		};
	}

	bool SetActive(std::uint32_t formId, const std::string& name, bool on)
	{
		auto* vm = Vm();
		if (!vm) {
			logger::warn("chim-activate: no VM");
			return false;
		}
		RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;   // fire-and-forget

		if (on) {
			auto* actor = ResolveActor(formId);
			if (!actor) {
				logger::warn("chim-activate: actor {:08X} not resolvable (not loaded?)", formId);
				return false;
			}
			bool salutation = true;   // greet on manual activation, like the spell
			auto args = RE::MakeFunctionArguments(
				std::move(static_cast<RE::Actor*>(actor)), std::move(salutation));
			logger::info("chim-activate: setDrivenByAIA({:08X})", formId);
			return vm->DispatchStaticCall(kScript, "setDrivenByAIA", args, cb);
		}

		RE::BSFixedString bn(name);
		auto             args = RE::MakeFunctionArguments(std::move(bn));
		logger::info("chim-activate: removeAgentByName('{}')", name);
		return vm->DispatchStaticCall(kScript, "removeAgentByName", args, cb);
	}

	void QueryActive(std::uint32_t /*formId*/, const std::string& name, StateCb cb)
	{
		auto* vm = Vm();
		if (!vm) {
			if (cb)
				cb(false, false);
			return;
		}
		RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> functor(new ActorResult(std::move(cb)));
		RE::BSFixedString bn(name);
		auto             args = RE::MakeFunctionArguments(std::move(bn));
		if (!vm->DispatchStaticCall(kScript, "getAgentByName", args, functor)) {
			// The functor won't fire (cb was moved into it). The view keeps its
			// last-known label; a state read is best-effort, never load-bearing.
			logger::warn("chim-activate: getAgentByName dispatch failed for '{}'", name);
		}
	}
}
