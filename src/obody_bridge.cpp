#include "obody_bridge.h"

#include "papyrus_presence.h"

#include "actor_identity.h"
#include "npc_actions.h"

#include <algorithm>
#include <cctype>
#include <utility>
#include <vector>

// pch (force-included) provides RE::/SKSE::/json and the logger.

// Windows.h (via the PCH) defines GetObject as GetObjectA, which renames
// RE::BSScript::Variable::GetObject (C2039). Same block as chim_control.cpp.
#ifdef GetObject
#	undef GetObject
#endif

namespace ObodyBridge
{
	namespace
	{
		using json = nlohmann::json;

		constexpr const char* kScript = "OBodyNative";

		std::string Dump(const json& j)
		{
			return j.dump(-1, ' ', false, json::error_handler_t::replace);
		}

		std::string Lower(std::string s)
		{
			std::transform(s.begin(), s.end(), s.begin(),
				[](unsigned char c) { return static_cast<char>(std::tolower(c)); });
			return s;
		}

		// UBE's races live in UBE_AllRace.esp and every one of them carries
		// "UBE" in its EditorID (00UBE_NordRace … 00UBE_CustomRace02). Either
		// test alone would do on this rig; both keep a renamed custom UBE race
		// from a follower mod (which keeps the prefix) and a re-saved copy of
		// the plugin (which keeps the file) on the right side.
		bool IsUbeRace(RE::TESRace* race)
		{
			if (!race)
				return false;
			if (const char* eid = race->GetFormEditorID(); eid && *eid) {
				if (Lower(eid).find("ube_") != std::string::npos)
					return true;
			}
			if (auto* file = race->GetFile(0)) {
				if (Lower(std::string(file->GetFilename())) == "ube_allrace.esp")
					return true;
			}
			return false;
		}

		json BodyOf(RE::Actor* actor)
		{
			auto* race = actor->GetRace();
			auto* base = actor->GetActorBase();
			const bool female = base && base->IsFemale();
			std::string raceName;
			if (race) {
				if (const char* n = race->GetName(); n && *n)
					raceName = n;
				else if (const char* eid = race->GetFormEditorID(); eid && *eid)
					raceName = eid;
			}
			std::string kind, label;
			if (IsUbeRace(race)) {
				kind = "ube";
				label = "UBE";
			} else if (female) {
				kind = "3ba";
				label = "3BA";
			} else {
				kind = "male";
				label = "Male";
			}
			return json{ { "kind", kind }, { "label", label }, { "female", female }, { "race", raceName } };
		}

		std::string NameOf(RE::Actor* actor)
		{
			if (const char* n = actor->GetDisplayFullName(); n && *n)
				return n;
			return "They";
		}

		// The view sends the roster's "0x…" hex id, or nothing for the
		// crosshair NPC. A bare number is accepted too (the crosshair target's
		// id travels as one on the F7 card).
		RE::Actor* TargetOf(const json& j, std::uint32_t& outId)
		{
			std::string fid;
			if (j.contains("formId")) {
				const auto& v = j["formId"];
				if (v.is_number_unsigned() || v.is_number_integer())
					fid = ActorIdentity::HexOf(v.get<std::uint32_t>());
				else if (v.is_string())
					fid = v.get<std::string>();
			}
			RE::Actor* actor = nullptr;
			if (!fid.empty() && ActorIdentity::ParseHex(fid))
				actor = ActorIdentity::ResolveActor(fid, j.value("plugin", std::string()));
			else if (const auto id = NpcActions::TargetFormID())
				actor = RE::TESForm::LookupByID<RE::Actor>(id);
			outId = actor ? actor->GetFormID() : 0;
			return actor;
		}

		// One functor for all three natives: read the answer HERE, on the VM's
		// thread, into plain data, then hop to the main thread before anything
		// touches the view.
		using Read = std::function<json(const RE::BSScript::Variable&)>;
		using Then = std::function<void(json)>;

		class Result final : public RE::BSScript::IStackCallbackFunctor
		{
		public:
			Result(Read read, Then then) :
				_read(std::move(read)), _then(std::move(then))
			{}

			void operator()(RE::BSScript::Variable a_result) override
			{
				json value = _read ? _read(a_result) : json();
				auto then = _then;
				if (!then)
					return;
				if (auto* task = SKSE::GetTaskInterface())
					task->AddTask([then, value = std::move(value)]() { then(value); });
			}

			bool CanSave() const override { return false; }
			void SetObject(const RE::BSTSmartPointer<RE::BSScript::Object>&) override {}

		private:
			Read _read;
			Then _then;
		};

		json ReadString(const RE::BSScript::Variable& v)
		{
			return v.IsString() ? json(std::string(v.GetString())) : json(std::string());
		}

		json ReadStrings(const RE::BSScript::Variable& v)
		{
			json out = json::array();
			if (v.IsArray()) {
				if (auto arr = v.GetArray()) {
					const auto n = arr->size();
					for (std::uint32_t i = 0; i < n; ++i) {
						const auto& e = (*arr)[i];
						if (e.IsString()) {
							std::string s(e.GetString());
							if (!s.empty())
								out.push_back(std::move(s));
						}
					}
				}
			}
			return out;
		}

		json ReadBool(const RE::BSScript::Variable& v)
		{
			return v.IsBool() && v.GetBool();
		}

		template <class... Args>
		bool Call(const char* fn, Read read, Then then, Args... args)
		{
			// No OBody NG in this game: say so (the callers' `missing` path)
			// instead of asking the VM for a class it cannot load, which is a
			// crash on 1.6.1170 (papyrus_presence.h). This runs on every F7
			// card, so it is the most exposed dispatch in the deck.
			if (!PapyrusPresence::ScriptAvailable(kScript))
				return false;
			auto* vm = RE::BSScript::Internal::VirtualMachine::GetSingleton();
			if (!vm)
				return false;
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb(new Result(std::move(read), std::move(then)));
			return vm->DispatchStaticCall(kScript, fn, RE::MakeFunctionArguments(std::move(args)...), cb);
		}

		json Envelope(const std::string& op, std::uint32_t id, RE::Actor* actor)
		{
			json r{ { "op", op }, { "ok", false }, { "formId", ActorIdentity::HexOf(id) } };
			if (actor) {
				r["name"] = NameOf(actor);
				r["body"] = BodyOf(actor);
			}
			return r;
		}

		const char* kMissing =
			"OBody NG isn't answering. Tick OBody NG in MO2 (4.3.7 or newer) and restart the game.";

		// Ask for the preset again after a change, so the card shows what
		// OBody actually holds now, not what we hoped it took.
		void SendCurrent(std::uint32_t id, json env, Reply reply)
		{
			auto* actor = RE::TESForm::LookupByID<RE::Actor>(id);
			if (!actor) {
				env["msg"] = "They aren't loaded right now.";
				reply(Dump(env));
				return;
			}
			const bool sent = Call("GetPresetAssignedToActor", ReadString,
				[env, reply](json preset) mutable {
					env["preset"] = preset;
					reply(Dump(env));
				},
				static_cast<RE::Actor*>(actor));
			if (!sent) {
				env["ok"] = false;
				env["missing"] = true;
				env["msg"] = kMissing;
				reply(Dump(env));
			}
		}
	}

	void Handle(const std::string& reqJson, Reply reply)
	{
		if (!reply)
			return;
		const auto j = json::parse(reqJson, nullptr, false);
		if (j.is_discarded() || !j.is_object()) {
			reply(Dump(json{ { "ok", false }, { "msg", "Bad request" } }));
			return;
		}
		const std::string op = j.value("op", std::string("get"));
		std::uint32_t     id = 0;
		auto*             actor = TargetOf(j, id);
		json              env = Envelope(op, id, actor);
		// Echo what the view asked about, so a reply for someone it has moved
		// on from is recognisable as stale.
		if (j.contains("formId"))
			env["asked"] = j["formId"];
		if (!actor) {
			env["msg"] = "They aren't loaded right now.";
			reply(Dump(env));
			return;
		}
		// OBody shapes people. A wolf, a dragon or a draugr gets no row at all.
		if (!actor->HasKeywordString("ActorTypeNPC")) {
			env["applies"] = false;
			env["msg"] = "OBody only shapes people.";
			reply(Dump(env));
			return;
		}
		env["applies"] = true;

		if (op == "list") {
			const bool sent = Call("GetAllPossiblePresets", ReadStrings,
				[env, reply, id](json presets) mutable {
					logger::info("obody-bridge: {:08X} lists {} preset(s)", id, presets.size());
					env["ok"] = true;
					env["presets"] = std::move(presets);
					// The current one rides along, so the picker can mark it.
					SendCurrent(id, std::move(env), reply);
				},
				static_cast<RE::Actor*>(actor));
			if (!sent) {
				env["missing"] = true;
				env["msg"] = kMissing;
				reply(Dump(env));
			}
			return;
		}

		if (op == "set") {
			const std::string name = j.value("preset", std::string());
			if (name.empty()) {
				env["msg"] = "Pick a preset first.";
				reply(Dump(env));
				return;
			}
			logger::info("obody-bridge: assign {:08X} '{}'", id, name);
			// forceImmediate = true, doNotApply = false: the morphs land now,
			// and no random fallback when the name is not in OBody's set.
			const bool sent = Call("AssignPresetToActor", ReadBool,
				[env, reply, id, name](json took) mutable {
					const bool ok = took.is_boolean() && took.get<bool>();
					env["ok"] = ok;
					env["wanted"] = name;
					if (!ok)
						env["msg"] = "OBody refused \"" + name + "\" — it is not one of its presets for this body.";
					logger::info("obody-bridge: assign {:08X} '{}' -> {}", id, name, ok ? "ok" : "refused");
					SendCurrent(id, std::move(env), reply);
				},
				static_cast<RE::Actor*>(actor), RE::BSFixedString(name), true, false);
			if (!sent) {
				env["missing"] = true;
				env["msg"] = kMissing;
				reply(Dump(env));
			}
			return;
		}

		// get
		env["ok"] = true;
		SendCurrent(id, std::move(env), reply);
	}
}
