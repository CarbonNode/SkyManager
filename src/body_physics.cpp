#include "body_physics.h"

#include <array>

// pch (force-included) provides RE::/SKSE::, logger and nlohmann json (<json.hpp>).

// Windows.h (dragged in by the PCH) defines GetObject as a macro expanding to
// GetObjectA, which mangles BOTH RE::BSScript::Variable::GetObject() and
// RE::InventoryEntryData::GetObject() below into members that do not exist
// (C2039 'GetObjectA'). Undo it locally — the house idiom, see chim_control.cpp
// / keys_scan.cpp. Worth knowing: MSVC's recovery from the resulting
// <error type> desyncs its parser far downstream, so the first build of this
// file also reported phantom syntax errors 90 lines away inside CupRestore.
#ifdef GetObject
#	undef GetObject
#endif

namespace BodyPhysics
{
	namespace
	{
		// ------------------------------------------------------------ the mod --

		constexpr const char* kPlugin = "3BBB.esp";
		constexpr const char* kModName = "CBBE 3BA";
		constexpr const char* kMcmScript = "Mus3BAddonMCM";
		constexpr const char* kMcmEdid = "Mus3BAddon";
		constexpr const char* kPmScript = "Mus3BPhysicsManager";
		constexpr const char* kPmEdid = "Mus3BPhysicsManager";

		constexpr const char* kOsmpPlugin = "OSmp.esp";
		constexpr const char* kOsmpModName = "OSmp";
		constexpr const char* kOsmpScript = "OSmpScript";

		// The MCM's SlotList is built in its OnInit as [$SLOT48, $SLOT50,
		// $SLOT51, $SLOT60] and NPCsTIndex/PsTIndex index it — so slot identity
		// is the INDEX, and these two tables are that index resolved. A biped
		// slot number N is bit (N - 30) of the armor's slot mask, which is what
		// GetWornArmor wants.
		constexpr int kSlotNum[4] = { 48, 50, 51, 60 };
		constexpr int kSlotBit[4] = { 18, 20, 21, 30 };

		// Cup -> the letter in the MCM's property names (SMPONObjectF<A..D><slot>).
		// A/B/C/D are SMP CONFIGS, not sizes: 3BA's own MCM info text says
		// "This does NOT affect breast size!"
		constexpr const char* kCupTag[4] = { "FA", "FB", "FC", "FD" };
		constexpr const char* kCupLabel[4] = { "A", "B", "C", "D" };
		constexpr const char* kCupDetail[4] = {
			"Least jiggle — stiff and quick to settle",
			"Gentle — a little give, settles fast",
			"Most jiggle — the bounciest of the four",
			"Heaviest — real weight and gravity, slow to settle",
		};

		// Mus3BPhysicsManager's six hand-over flags: which body parts stop
		// being driven by CBPC when the SMP object goes on. All six off means
		// the object is worn but nothing actually changes hands — which is
		// exactly the "the toggle did nothing" report, so the tab shows them.
		struct PartDef
		{
			const char* key;
			const char* var;
			const char* label;
		};
		constexpr PartDef kParts[6] = {
			{ "breast", "BreastSMP", "Breasts" },
			{ "butt", "ButtSMP", "Butt" },
			{ "belly", "BellySMP", "Belly" },
			{ "thigh", "ThighSMP", "Thighs & calves" },
			{ "vagina", "VaginaSMP", "Vagina" },
			{ "vaginaCollision", "VaginaCollisionSMP", "Vagina collision" },
		};

		// OSmp's four booleans, in the order its own MCM page lists them.
		struct OsmpDef
		{
			const char* key;
			const char* var;
		};
		constexpr OsmpDef kOsmpToggles[4] = {
			{ "keepPlayer", "toggleKeepPlayerSMP" },
			{ "keepNpc", "toggleKeepNPCSMP" },
			{ "disabled", "toggleDisableOSmp" },
			{ "autoCup", "toggleAutomaticCup" },
		};

		// ------------------------------------------------------- house idioms --
		// Local copies (the spellcraft_actions / follower_frameworks rule: each
		// module carries its own so none grows a dependency on another's guts).

		std::string Lower(std::string s)
		{
			for (auto& c : s)
				c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
			return s;
		}

		std::string PluginOf(const RE::TESForm* f)
		{
			if (!f)
				return "";
			if (const auto* file = f->GetFile(0))
				return file->GetFilename().data();
			return "";
		}

		bool PluginPresent(const char* plugin)
		{
			auto* dh = RE::TESDataHandler::GetSingleton();
			return dh && (dh->LookupLoadedModByName(plugin) != nullptr ||
							 dh->LookupLoadedLightModByName(plugin) != nullptr);
		}

		RE::BSScript::Internal::VirtualMachine* Vm()
		{
			return RE::BSScript::Internal::VirtualMachine::GetSingleton();
		}

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

		// GetProperty first, then GetVariable — the keys_scan order, because a
		// script exposes some of these as properties and some as bare variables.
		// For an AUTO property this hands back the backing slot, so writing
		// through it is the same write the mod's own MCM makes.
		RE::BSScript::Variable* ScriptVar(RE::BSScript::Object* obj, const char* name)
		{
			if (!obj || !name)
				return nullptr;
			if (auto* v = obj->GetProperty(name))
				return v;
			return obj->GetVariable(name);
		}

		std::int32_t VarInt(RE::BSScript::Variable* v, std::int32_t fallback)
		{
			if (!v)
				return fallback;
			if (v->IsInt())
				return v->GetSInt();
			if (v->IsFloat())
				return static_cast<std::int32_t>(v->GetFloat());
			return fallback;
		}

		float VarFloat(RE::BSScript::Variable* v, float fallback)
		{
			if (!v)
				return fallback;
			if (v->IsFloat())
				return v->GetFloat();
			if (v->IsInt())
				return static_cast<float>(v->GetSInt());
			return fallback;
		}

		bool VarBool(RE::BSScript::Variable* v, bool fallback)
		{
			return (v && v->IsBool()) ? v->GetBool() : fallback;
		}

		// The fertility_bridge idiom verbatim: object variable -> live form,
		// through the handle policy, type-checked.
		RE::TESForm* VarForm(RE::BSScript::Variable* v, RE::FormType type)
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

		RE::TESObjectARMO* VarArmor(RE::BSScript::Object* obj, const std::string& name)
		{
			auto* form = VarForm(ScriptVar(obj, name.c_str()), RE::FormType::Armor);
			return form ? form->As<RE::TESObjectARMO>() : nullptr;
		}

		// ------------------------------------------------------ quest binding --

		// Cache the FormID, not the pointer (follower_frameworks QuestCache):
		// re-resolving costs a hash lookup and cannot outlive the form it names.
		struct QuestCache
		{
			bool       tried = false;
			RE::FormID id = 0;
		};

		// Find the quest in `plugin` that carries `script`. The editor id is
		// tried first (po3's cache is on this load order), then a scan of the
		// plugin's own quests — so a renamed record still resolves.
		RE::TESQuest* FindQuest(QuestCache& cache, const char* plugin, const char* edid, const char* script)
		{
			if (cache.tried) {
				if (cache.id == 0)
					return nullptr;
				if (auto* form = RE::TESForm::LookupByID(cache.id))
					if (auto* q = form->As<RE::TESQuest>())
						return q;
				cache.tried = false;  // the cached form vanished — look again
			}

			RE::TESQuest* found = nullptr;
			if (edid && *edid) {
				if (auto* form = RE::TESForm::LookupByEditorID(edid))
					if (auto* q = form->As<RE::TESQuest>(); q && BindScript(q, script))
						found = q;
			}
			if (!found) {
				const std::string want = Lower(plugin);
				if (auto* dh = RE::TESDataHandler::GetSingleton()) {
					for (auto* q : dh->GetFormArray<RE::TESQuest>()) {
						if (!q || Lower(PluginOf(q)) != want)
							continue;
						if (!BindScript(q, script))
							continue;
						found = q;
						break;
					}
				}
			}

			cache.tried = true;
			cache.id = found ? found->GetFormID() : 0;
			if (!found)
				logger::warn("body-physics: {} is loaded but no quest in it carries {}", plugin, script);
			return found;
		}

		QuestCache g_mcmCache{};
		QuestCache g_pmCache{};
		QuestCache g_osmpCache{};

		// ---------------------------------------------------- the bound state --

		// Everything the tab needs, read live off the mod's own script objects.
		// Re-read on every call: the MCM's slot/cup are user settings that can
		// change between two opens of the deck, and a stale copy would make the
		// tab lie.
		struct Mcm
		{
			RE::TESQuest*                             quest = nullptr;
			RE::BSTSmartPointer<RE::BSScript::Object> obj;
			RE::TESObjectARMO*                        npc[4][4] = {};  // [cup][slotIdx]
			RE::TESObjectARMO*                        player[4] = {};  // [slotIdx]
			int                                       cupNum = 3;
			int                                       slotIdx = 1;
			bool                                      npcGender = true;
			bool                                      playerGender = true;
			bool                                      formsOk = false;
		};

		bool ReadMcm(Mcm& m)
		{
			m.quest = FindQuest(g_mcmCache, kPlugin, kMcmEdid, kMcmScript);
			if (!m.quest)
				return false;
			m.obj = BindScript(m.quest, kMcmScript);
			if (!m.obj)
				return false;

			auto* o = m.obj.get();
			m.cupNum = VarInt(ScriptVar(o, "CupNum"), 3);
			m.slotIdx = VarInt(ScriptVar(o, "NPCsTIndex"), 1);
			m.npcGender = VarBool(ScriptVar(o, "NPCGenderToggle"), true);
			m.playerGender = VarBool(ScriptVar(o, "PlayerGenderToggle"), true);
			if (m.cupNum < 0 || m.cupNum > 3)
				m.cupNum = 3;
			if (m.slotIdx < 0 || m.slotIdx > 3)
				m.slotIdx = 1;

			int resolved = 0;
			for (int c = 0; c < 4; ++c) {
				for (int s = 0; s < 4; ++s) {
					m.npc[c][s] = VarArmor(o, std::string("SMPONObject") + kCupTag[c] + std::to_string(kSlotNum[s]));
					if (m.npc[c][s])
						++resolved;
				}
			}
			for (int s = 0; s < 4; ++s)
				m.player[s] = VarArmor(o, std::string("SMPONObjectP") + std::to_string(kSlotNum[s]));

			// The switch objects ARE the feature — with none of them resolved
			// there is nothing to read or write, and saying so beats a tab of
			// dead controls.
			m.formsOk = resolved > 0;
			return m.formsOk;
		}

		// --------------------------------------------------------- worn state --

		struct Worn
		{
			int  cup = -1;      // -1 = no switch object found
			int  slotIdx = -1;
			bool worn = false;  // false + cup >= 0 = carried but knocked off
		};

		// One pass over her inventory changes. `worn` is the truth that matters:
		// the SMP config lives in the object's NIF, so an object sitting in the
		// pack (an outfit claimed the same biped slot) drives nothing — even
		// though 3BA's own GetItemCount test would call her SMP.
		Worn ReadWorn(RE::Actor* a, const Mcm& m, bool isPlayer)
		{
			Worn w;
			if (!a)
				return w;
			auto* ic = a->GetInventoryChanges(true);  // noInit: never create one
			if (!ic || !ic->entryList)
				return w;

			for (auto* entry : *ic->entryList) {
				if (!entry)
					continue;
				auto* obj = entry->GetObject();
				if (!obj)
					continue;
				int cup = -1;
				int slot = -1;
				if (isPlayer) {
					for (int s = 0; s < 4; ++s) {
						if (m.player[s] && m.player[s] == obj) {
							cup = -1;
							slot = s;
							break;
						}
					}
					if (slot < 0)
						continue;
				} else {
					for (int c = 0; c < 4 && slot < 0; ++c)
						for (int s = 0; s < 4; ++s)
							if (m.npc[c][s] && m.npc[c][s] == obj) {
								cup = c;
								slot = s;
								break;
							}
					if (slot < 0)
						continue;
				}
				const bool isWorn = entry->IsWorn();
				if (isWorn) {
					w.cup = cup;
					w.slotIdx = slot;
					w.worn = true;
					return w;  // worn beats carried — stop at the first one
				}
				if (w.slotIdx < 0) {  // remember the first carried-but-off one
					w.cup = cup;
					w.slotIdx = slot;
				}
			}
			return w;
		}

		// --------------------------------------------------------- dispatching --

		// Fire-and-forget into the MCM script. Every write the tab makes is one
		// of these; the fresh fxState the bridge pushes right after is what
		// tells the view whether it took (a Papyrus call that the mod's own
		// state guard swallowed simply shows the unchanged truth).
		bool CallMcm(const Mcm& m, const char* fn, RE::Actor* actor, bool passActor, bool passIsSpell)
		{
			auto* vm = Vm();
			if (!vm || !m.quest || !fn)
				return false;
			auto* policy = vm->GetObjectHandlePolicy();
			if (!policy)
				return false;
			const auto handle = policy->GetHandleForObject(RE::TESQuest::FORMTYPE, m.quest);
			if (handle == policy->EmptyHandle())
				return false;

			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			if (!passActor) {
				auto args = RE::MakeFunctionArguments();
				return vm->DispatchMethodCall(handle, kMcmScript, fn, args, cb);
			}
			if (!actor)
				return false;
			if (passIsSpell) {
				// RemoveSMP(actor, bool isSpell) — every argument is passed
				// explicitly: the VM builds the frame from what we hand it, it
				// does not fill a Papyrus default for us.
				auto args = RE::MakeFunctionArguments(
					std::move(static_cast<RE::Actor*>(actor)),
					std::move(static_cast<bool>(false)));
				return vm->DispatchMethodCall(handle, kMcmScript, fn, args, cb);
			}
			auto args = RE::MakeFunctionArguments(std::move(static_cast<RE::Actor*>(actor)));
			return vm->DispatchMethodCall(handle, kMcmScript, fn, args, cb);
		}

		// AddNPCSMP reads CupNum at call time, so a per-person cup means
		// setting the mod's own default, calling, and PUTTING IT BACK — the
		// deck must not silently re-write a setting Rober chose in the MCM.
		// The restore is queued behind the dispatch on the same main-thread
		// task queue, which is ordered: the VM runs the call from the frame we
		// just pushed before our next task lands.
		class CupRestore : public RE::BSScript::IStackCallbackFunctor
		{
		public:
			CupRestore(RE::FormID quest, std::int32_t cup) :
				_quest(quest), _cup(cup)
			{}

			void operator()(RE::BSScript::Variable) override
			{
				const auto quest = _quest;
				const auto cup = _cup;
				if (auto* task = SKSE::GetTaskInterface())
					task->AddTask([quest, cup]() {
						auto* form = RE::TESForm::LookupByID(quest);
						auto* q = form ? form->As<RE::TESQuest>() : nullptr;
						if (!q)
							return;
						auto obj = BindScript(q, kMcmScript);
						if (!obj)
							return;
						if (auto* v = ScriptVar(obj.get(), "CupNum"))
							v->SetSInt(cup);
					});
			}

			bool CanSave() const override { return false; }
			void SetObject(const RE::BSTSmartPointer<RE::BSScript::Object>&) override {}

		private:
			RE::FormID   _quest;
			std::int32_t _cup;
		};

		// CupNum := cup, then AddNPCSMP(actor), then CupNum back to what it was.
		bool ApplyCup(const Mcm& m, RE::Actor* actor, int cup)
		{
			auto* vm = Vm();
			if (!vm || !m.quest || !actor || cup < 0 || cup > 3)
				return false;
			auto* policy = vm->GetObjectHandlePolicy();
			if (!policy)
				return false;
			const auto handle = policy->GetHandleForObject(RE::TESQuest::FORMTYPE, m.quest);
			if (handle == policy->EmptyHandle())
				return false;

			auto* var = ScriptVar(m.obj.get(), "CupNum");
			if (!var)
				return false;
			const auto had = static_cast<std::int32_t>(m.cupNum);
			var->SetSInt(static_cast<std::int32_t>(cup));

			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb(
				new CupRestore(m.quest->GetFormID(), had));
			auto args = RE::MakeFunctionArguments(std::move(static_cast<RE::Actor*>(actor)));
			if (vm->DispatchMethodCall(handle, kMcmScript, "AddNPCSMP", args, cb))
				return true;

			var->SetSInt(had);  // never leave the mod's setting on the floor
			return false;
		}

		// ---------------------------------------------------------- json shape --

		std::string Dump(const nlohmann::json& j)
		{
			return j.dump(-1, ' ', false, nlohmann::json::error_handler_t::replace);
		}

		std::string Reply(bool ok, const std::string& msg, const std::string& id, bool on)
		{
			nlohmann::json j;
			j["ok"] = ok;
			j["msg"] = msg;
			j["id"] = id;
			j["on"] = on;
			return Dump(j);
		}

		RE::Actor* ActorFor(std::uint32_t formId)
		{
			if (!formId)
				return nullptr;
			return RE::TESForm::LookupByID<RE::Actor>(formId);
		}

		std::string NameOf(RE::Actor* a)
		{
			const char* n = a ? a->GetDisplayFullName() : nullptr;
			return (n && *n) ? std::string(n) : std::string("she");
		}

		bool IsFemale(RE::Actor* a)
		{
			auto* base = a ? a->GetActorBase() : nullptr;
			return base && base->IsFemale();
		}

		// The mod's gender rule, pre-checked so a refusal is a sentence in the
		// tab instead of a Papyrus call that quietly does nothing.
		bool GenderBlocked(const Mcm& m, RE::Actor* a, bool isPlayer)
		{
			const bool rule = isPlayer ? m.playerGender : m.npcGender;
			return rule && !IsFemale(a);
		}

		// OSmp's block. Read-only for the weights (its own MCM owns those
		// sliders); the four booleans are plain auto properties, so the deck
		// writes them the same way its own MCM does.
		nlohmann::json OsmpJson()
		{
			nlohmann::json o;
			o["present"] = false;
			if (!PluginPresent(kOsmpPlugin))
				return o;
			auto* q = FindQuest(g_osmpCache, kOsmpPlugin, nullptr, kOsmpScript);
			auto  obj = q ? BindScript(q, kOsmpScript) : RE::BSTSmartPointer<RE::BSScript::Object>{};
			if (!obj)
				return o;
			o["present"] = true;
			auto* s = obj.get();
			for (const auto& t : kOsmpToggles)
				o[t.key] = VarBool(ScriptVar(s, t.var), t.key == std::string("disabled") ? false : true);
			auto w = nlohmann::json::array();
			w.push_back(VarFloat(ScriptVar(s, "aCupMaximumWeight"), 25.0f));
			w.push_back(VarFloat(ScriptVar(s, "bCupMaximumWeight"), 50.0f));
			w.push_back(VarFloat(ScriptVar(s, "cCupMaximumWeight"), 75.0f));
			w.push_back(VarFloat(ScriptVar(s, "dCupMaximumWeight"), 100.0f));
			o["weights"] = w;
			return o;
		}

		// The six CBPC->SMP hand-over flags, off Mus3BPhysicsManager.
		nlohmann::json PartsJson(int& onCount)
		{
			onCount = 0;
			auto arr = nlohmann::json::array();
			auto* q = FindQuest(g_pmCache, kPlugin, kPmEdid, kPmScript);
			auto  obj = q ? BindScript(q, kPmScript) : RE::BSTSmartPointer<RE::BSScript::Object>{};
			for (const auto& p : kParts) {
				nlohmann::json e;
				e["key"] = p.key;
				e["label"] = p.label;
				const bool on = obj ? VarBool(ScriptVar(obj.get(), p.var), false) : false;
				e["on"] = on;
				if (on)
					++onCount;
				arr.push_back(e);
			}
			if (!obj)
				onCount = -1;  // unknown, not "all off"
			return arr;
		}
	}

	// ------------------------------------------------------------- the state --

	nlohmann::json BodyJson(std::uint32_t formId)
	{
		nlohmann::json j;
		j["present"] = PluginPresent(kPlugin);
		j["available"] = false;
		if (!j["present"].get<bool>()) {
			j["reason"] = std::string(kModName) + " isn't in the load order";
			return j;
		}

		Mcm m;
		if (!ReadMcm(m)) {
			j["reason"] = std::string(kModName) +
				" is installed but its MCM quest didn't answer — has it been started in this save?";
			return j;
		}

		auto* a = ActorFor(formId);
		if (!a) {
			j["reason"] = "that NPC isn't loaded any more";
			return j;
		}
		const bool isPlayer = a->IsPlayerRef();
		const Worn w = ReadWorn(a, m, isPlayer);

		j["available"] = true;
		j["isPlayer"] = isPlayer;
		j["mode"] = w.worn ? "smp" : "cbpc";
		j["cup"] = w.worn ? w.cup : -1;
		j["cupLabel"] = (w.worn && w.cup >= 0 && w.cup < 4) ? kCupLabel[w.cup] : "";
		j["defaultCup"] = m.cupNum;
		j["defaultCupLabel"] = kCupLabel[m.cupNum];
		j["slot"] = kSlotNum[m.slotIdx];
		j["wornSlot"] = (w.slotIdx >= 0) ? kSlotNum[w.slotIdx] : 0;
		j["slotStale"] = (w.slotIdx >= 0 && w.slotIdx != m.slotIdx);
		j["stranded"] = (!w.worn && w.slotIdx >= 0);

		if (GenderBlocked(m, a, isPlayer)) {
			j["blocked"] = NameOf(a) + " isn't female — 3BA's own rule refuses "
						   "anyone else (its MCM can turn that check off)";
		}

		auto cups = nlohmann::json::array();
		for (int c = 0; c < 4; ++c) {
			nlohmann::json e;
			e["n"] = c;
			e["label"] = kCupLabel[c];
			e["detail"] = kCupDetail[c];
			cups.push_back(e);
		}
		j["cups"] = cups;

		int partsOn = 0;
		j["parts"] = PartsJson(partsOn);
		j["partsOn"] = partsOn;

		j["osmp"] = OsmpJson();

		// Build marker (hd-markers.json: "3ba-body-physics") — reached on every
		// fxGet, i.e. each time the quick card looks at someone.
		logger::info("3ba-body-physics: state {:08X} mode={} cup={}",
			formId, w.worn ? "smp" : "cbpc", w.cup);
		return j;
	}

	// ------------------------------------------------------------- the writes --

	std::string Apply(std::uint32_t formId, const std::string& id, bool on)
	{
		if (!PluginPresent(kPlugin))
			return Reply(false, std::string(kModName) + " isn't in the load order", id, on);

		// ---- OSmp's own toggles. Plain auto properties on its quest script,
		// so the write IS the state — no function to call, and it persists in
		// the save exactly like a change made in its MCM.
		if (id.rfind("3ba:osmp:", 0) == 0) {
			const std::string key = id.substr(9);
			if (!PluginPresent(kOsmpPlugin))
				return Reply(false, std::string(kOsmpModName) + " isn't in the load order", id, on);
			auto* q = FindQuest(g_osmpCache, kOsmpPlugin, nullptr, kOsmpScript);
			auto  obj = q ? BindScript(q, kOsmpScript) : RE::BSTSmartPointer<RE::BSScript::Object>{};
			if (!obj)
				return Reply(false, "OSmp's script didn't answer — has it started in this save?", id, on);
			for (const auto& t : kOsmpToggles) {
				if (key != t.key)
					continue;
				auto* v = ScriptVar(obj.get(), t.var);
				if (!v)
					return Reply(false, std::string("OSmp has no ") + t.var + " — mod updated?", id, on);
				v->SetBool(on);
				logger::info("3ba-body-physics: osmp {} = {}", t.var, on);
				return Reply(true, "OSmp setting saved", id, on);
			}
			return Reply(false, "unknown OSmp setting", id, on);
		}

		Mcm m;
		if (!ReadMcm(m))
			return Reply(false, std::string(kModName) +
					" is installed but its MCM quest didn't answer — has it been started in this save?",
				id, on);

		auto* a = ActorFor(formId);
		if (!a)
			return Reply(false, "that NPC isn't loaded any more", id, on);
		const bool        isPlayer = a->IsPlayerRef();
		const std::string name = NameOf(a);

		if (GenderBlocked(m, a, isPlayer))
			return Reply(false, name + " isn't female — 3BA refuses anyone else", id, on);

		const Worn w = ReadWorn(a, m, isPlayer);

		// ---- the cup. Works from either side: AddNPCSMP strips whatever
		// switch object she has and equips the one for the cup we ask for, so
		// this is both "turn it on at C" and "change her to C".
		if (id.rfind("3ba:cup:", 0) == 0) {
			if (isPlayer)
				return Reply(false, "the player has a single SMP setup — 3BA offers no cup there", id, on);
			const std::string tail = id.substr(8);
			int               cup = -1;
			if (tail.size() == 1 && tail[0] >= '0' && tail[0] <= '3')
				cup = tail[0] - '0';
			if (cup < 0)
				return Reply(false, "unknown cup", id, on);
			if (w.worn && w.cup == cup)
				return Reply(true, std::string("Already cup ") + kCupLabel[cup], id, true);

			// A stranded object (carried, knocked off by an outfit in the same
			// slot) makes AddNPCSMP return early — 3BA counts the pack, not the
			// body. Clear it first so the equip actually happens.
			if (!w.worn && w.slotIdx >= 0)
				CallMcm(m, "RemoveSMP", a, true, true);

			if (!ApplyCup(m, a, cup))
				return Reply(false, "couldn't reach 3BA's own switch — mod updated?", id, on);
			logger::info("3ba-body-physics: cup {} on {:08X}", kCupLabel[cup], formId);
			return Reply(true, std::string("Cup ") + kCupLabel[cup] + " — " + name + " is on SMP", id, true);
		}

		// ---- the plain on/off.
		if (id == "3ba:physics") {
			if (!on) {
				if (!w.worn && w.slotIdx < 0)
					return Reply(true, name + " is already on CBPC", id, false);
				if (!CallMcm(m, "RemoveSMP", a, true, true))
					return Reply(false, "couldn't reach 3BA's own switch — mod updated?", id, on);
				logger::info("3ba-body-physics: off {:08X}", formId);
				return Reply(true, "SMP off — " + name + " is back on CBPC", id, false);
			}

			if (w.worn)
				return Reply(true, name + " is already on SMP", id, true);

			if (isPlayer) {
				// The player's own path: no cup, and PlayerSMP() is a toggle —
				// safe here because we only call it having just read her as off.
				if (!CallMcm(m, "PlayerSMP", nullptr, false, false))
					return Reply(false, "couldn't reach 3BA's own switch — mod updated?", id, on);
				logger::info("3ba-body-physics: player smp on");
				return Reply(true, "SMP on", id, true);
			}

			if (w.slotIdx >= 0)
				CallMcm(m, "RemoveSMP", a, true, true);  // clear a stranded object first
			if (!ApplyCup(m, a, m.cupNum))
				return Reply(false, "couldn't reach 3BA's own switch — mod updated?", id, on);
			logger::info("3ba-body-physics: on {:08X} cup {}", formId, kCupLabel[m.cupNum]);
			return Reply(true, "SMP on — " + name + ", cup " + kCupLabel[m.cupNum], id, true);
		}

		return Reply(false, "unknown body-physics action", id, on);
	}
}
