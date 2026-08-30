// Spell Crafting tab engine. See spellcraft_actions.h for the contract and
// spellcraft-wiring.md for the main.cpp hunks.
//
// Design notes that are load-bearing:
//  - FESC's quest is found by ATTACHED SCRIPT inside its own plugin (the
//    follower_frameworks::ControllerQuest pattern), EDID as the fallback, and
//    the cache holds the FormID, never the pointer.
//  - The override craft NEVER dispatches their CraftTheSpell with
//    overriding=true: that branch calls the FESC DLL native SetEffectStuff,
//    which dereferences a menu global (OverideBase) that is null unless their
//    own ImGui menu set it - a guaranteed CTD. The C++ mirror below follows
//    their decompiled Papyrus exactly, replacing only that native with two
//    engine-side writes (EffectSetting data.delivery/castingType) and a
//    TESFullName assignment.
//  - Every DPF call is CHAINED through its result callback: separate
//    dispatches are separate VM stacks, so ordering between them is only
//    guaranteed by issuing the next call from inside the previous call's
//    IStackCallbackFunctor (the keys_scan StringResult shape, hopped to the
//    main thread first). A 10s per-step watchdog aborts a chain whose VM
//    stopped answering; AddSpell is the LAST link, so an aborted chain never
//    teaches a half-built spell, and charged gold is refunded.
//  - Gold and the tome count are read with the finance.cpp SEH-guarded raw
//    walk - never GetInventory<>(), which has faulted on this load order.
//  - Local ids are ActorIdentity::LocalIdOf (file-width mask), NEVER
//    CommonLib's GetLocalFormID() - the 2026-08-03 null-deref lesson.
//  - All JSON is dumped with error_handler_t::replace: names come out of
//    arbitrary ESPs and are not guaranteed UTF-8.

#include "spellcraft_actions.h"

#include "pch.h"

#include "actor_identity.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <memory>
#include <optional>
#include <string>
#include <thread>
#include <vector>

// Something in this TU's include graph pulls <Windows.h> without NOMINMAX:
// `min`/`max` break std:: and `GetObject` renames Variable::GetObject to
// GetObjectA. Neutralize all three - file scope, nothing here wants them.
// (keys_scan.cpp carries the same block for the same reason.)
#ifdef GetObject
#	undef GetObject
#endif
#ifdef min
#	undef min
#endif
#ifdef max
#	undef max
#endif

namespace SpellCraft
{
	namespace
	{
		using json = nlohmann::json;

		// ---------------------------------------------------------- constants --
		constexpr const char* kFescPlugin = "EM03SpellCrafting.esp";
		constexpr const char* kQuestScript = "EM03QuestScript";
		constexpr const char* kBookScript = "EM03CraftSpellScript";
		constexpr const char* kQuestEdid = "EM03SCScriptQuest";
		constexpr const char* kDpfClass = "DynamicPersistentForms";
		constexpr const char* kDpfPlugin = "DPF.esp";
		constexpr RE::FormID  kGold = 0x0000000F;  // Gold001
		constexpr std::size_t kMaxIcons = 512;     // sidecar map ceiling

		// -------------------------------------------------------------- utils --
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

		// The plugin a form was DEFINED in (index 0) - same idiom every module
		// carries (spell_actions::PluginOf).
		std::string PluginOf(const RE::TESForm* form)
		{
			if (form) {
				if (auto* file = form->GetFile(0))
					return std::string(file->GetFilename());
			}
			return "";
		}

		std::string NameOf(RE::TESForm* f)
		{
			if (!f)
				return "";
			const char* nm = f->GetName();
			return (nm && *nm) ? std::string(nm) : std::string();
		}

		// The sidecar key: "<plugin>|<localIdHex>", hex zero-padded to 6 like
		// item-explorer's row ids - this module owns both ends of the map, so
		// one fixed spelling is all that is needed.
		std::string IconKey(const std::string& plugin, std::uint32_t localId)
		{
			char hex[16];
			std::snprintf(hex, sizeof(hex), "%06X", localId);
			return plugin + "|" + hex;
		}

		template <class T>
		T* ResolveForm(const std::string& plugin, std::uint32_t localId)
		{
			if (plugin.empty() || !localId)
				return nullptr;
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!dh)
				return nullptr;
			auto* form = dh->LookupForm(localId, plugin);
			return form ? form->As<T>() : nullptr;
		}

		// The effects_actions idiom verbatim (full + light lookups both).
		bool PluginPresent(const char* plugin)
		{
			auto* dh = RE::TESDataHandler::GetSingleton();
			return dh && (dh->LookupLoadedModByName(plugin) != nullptr ||
							 dh->LookupLoadedLightModByName(plugin) != nullptr);
		}

		// ----------------------------------------------------------- vm idioms --
		// Local copies of the house idioms (keys_scan / fertility_bridge) - each
		// deck module carries its own so none grows a dependency on another's
		// internals.

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

		bool HasScript(RE::TESForm* form, const char* cls)
		{
			return static_cast<bool>(BindScript(form, cls));
		}

		// GetProperty first, then GetVariable - the keys_scan order, because a
		// script exposes some of these as properties and some as bare variables.
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

		// A Form[] script variable/property -> per-slot forms (null slots kept
		// as null so array INDEXES stay aligned with the mod's own tables).
		std::vector<RE::TESForm*> VarFormArray(RE::BSScript::Variable* v, RE::FormType type)
		{
			std::vector<RE::TESForm*> out;
			if (!v || !v->IsArray())
				return out;
			auto arr = v->GetArray();
			if (!arr)
				return out;
			for (std::uint32_t i = 0; i < arr->size(); ++i)
				out.push_back(VarForm(&(*arr)[i], type));
			return out;
		}

		// The same, but from a Variable delivered by value (a callback result).
		RE::TESForm* FormFromResult(RE::BSScript::Variable v, RE::FormType type)
		{
			return VarForm(&v, type);
		}

		// ---------------------------------------------------------- FESC bind --

		// Cache the quest's FormID, not the pointer (follower_frameworks
		// QuestCache) - re-resolving costs a hash lookup and cannot outlive the
		// form it names.
		bool       g_questTried = false;
		RE::FormID g_questId = 0;
		bool       g_boundLogged = false;

		RE::TESQuest* FescQuest()
		{
			if (g_questTried) {
				if (g_questId == 0)
					return nullptr;
				if (auto* form = RE::TESForm::LookupByID(g_questId))
					return form->As<RE::TESQuest>();
				g_questTried = false;  // cached form vanished - look again
			}

			RE::TESQuest*     found = nullptr;
			const std::string want = Lower(kFescPlugin);
			if (auto* dh = RE::TESDataHandler::GetSingleton()) {
				for (auto* q : dh->GetFormArray<RE::TESQuest>()) {
					if (!q || Lower(PluginOf(q)) != want)
						continue;
					if (!HasScript(q, kQuestScript))
						continue;
					found = q;
					break;
				}
			}
			if (!found) {
				if (auto* form = RE::TESForm::LookupByEditorID(kQuestEdid)) {
					if (auto* q = form->As<RE::TESQuest>(); q && HasScript(q, kQuestScript))
						found = q;
				}
			}

			g_questTried = true;
			g_questId = found ? found->GetFormID() : 0;
			if (found && !g_boundLogged) {
				g_boundLogged = true;
				// Build marker (hd-markers.json: "spellcraft-bridge").
				logger::info("spellcraft: bound - quest {:08X} ({}) carries {}",
					found->GetFormID(), kFescPlugin, kQuestScript);
			}
			if (!found)
				logger::warn("spellcraft: no quest in {} carries {} (and EDID '{}' resolved nothing)",
					kFescPlugin, kQuestScript, kQuestEdid);
			return found;
		}

		RE::BSTSmartPointer<RE::BSScript::Object> QuestObj()
		{
			return BindScript(FescQuest(), kQuestScript);
		}

		// Is DynamicPersistentForms callable? VM type lookup first (the
		// authoritative answer once scripts are loaded), BSResource pex probe
		// as the fallback (loose file or BSA both answer it).
		bool g_dpfKnownGood = false;

		bool DpfAvailable()
		{
			if (g_dpfKnownGood)
				return true;
			if (auto* vm = Vm()) {
				RE::BSTSmartPointer<RE::BSScript::ObjectTypeInfo> info;
				// COMPILE-CHECK: CommonLibSSE-NG spells this GetScriptObjectType
				// (className, outTypeInfo); if the overload set differs, the
				// BSResource probe below is the whole check.
				if (vm->GetScriptObjectType(RE::BSFixedString(kDpfClass), info) && info) {
					g_dpfKnownGood = true;
					return true;
				}
			}
			RE::BSResourceNiBinaryStream probe("Scripts\\DynamicPersistentForms.pex");
			if (probe.good()) {
				g_dpfKnownGood = true;
				return true;
			}
			return false;
		}

		// ---------------------------------------------------------- settings --

		struct SettingsSnap
		{
			bool        ok = false;
			std::string reason;
			int         effectCost = 10;
			int         tomeCost = 0;
			bool        mustKnowPerk = false;
			float       magExp = 1.1f;
			float       dMult = 1.0f;
			float       aMult = 1.0f;
			int         sliderMax = 100;
			bool        fullScreen = false;
			bool        showOgCost = true;
		};

		// ApplySettings passes FullScreen/ShowOgCost through UNCHANGED from the
		// last read - the deck has no UI for them, and zeroing a display flag
		// the player set in FESC's own menu would be a silent config edit.
		bool g_haveDisplayFlags = false;
		bool g_lastFullScreen = false;
		bool g_lastShowOgCost = true;

		SettingsSnap ReadSettings()
		{
			SettingsSnap s;
			if (!PluginPresent(kFescPlugin)) {
				s.reason = "Fourth Era Spell-Crafting (EM03SpellCrafting.esp) isn't in the load order";
				return s;
			}
			auto obj = QuestObj();
			if (!obj) {
				s.reason = FescQuest()
				               ? "FESC's quest script wouldn't bind - Papyrus not up yet, or the mod changed"
				               : "FESC is installed but its crafting quest couldn't be found - mod updated?";
				return s;
			}
			s.ok = true;
			s.effectCost = VarInt(ScriptVar(obj.get(), "EffectCost"), s.effectCost);
			s.mustKnowPerk = VarBool(ScriptVar(obj.get(), "MustKnowPerk"), s.mustKnowPerk);
			s.magExp = VarFloat(ScriptVar(obj.get(), "MagExp"), s.magExp);
			s.dMult = VarFloat(ScriptVar(obj.get(), "DMult"), s.dMult);
			s.aMult = VarFloat(ScriptVar(obj.get(), "AMult"), s.aMult);
			s.sliderMax = VarInt(ScriptVar(obj.get(), "sliderMax"), s.sliderMax);
			s.fullScreen = VarBool(ScriptVar(obj.get(), "FullScreen"), s.fullScreen);
			s.showOgCost = VarBool(ScriptVar(obj.get(), "ShowOgCost"), s.showOgCost);
			if (auto* g = VarForm(ScriptVar(obj.get(), "TomeCostGlobal"), RE::FormType::Global)) {
				if (auto* global = g->As<RE::TESGlobal>())
					s.tomeCost = static_cast<int>(global->value);
			}
			g_haveDisplayFlags = true;
			g_lastFullScreen = s.fullScreen;
			g_lastShowOgCost = s.showOgCost;
			return s;
		}

		json SettingsJson(const SettingsSnap& s)
		{
			return json{
				{ "effectCost", s.effectCost },
				{ "tomeCost", s.tomeCost },
				{ "mustKnowPerk", s.mustKnowPerk },
				{ "magExp", s.magExp },
				{ "dMult", s.dMult },
				{ "aMult", s.aMult },
				{ "sliderMax", s.sliderMax },
			};
		}

		// The learn-effects toggle ability: property LearnEffectsSpell on the
		// script attached to the TomeOfSC BOOK base form. Fallback: po3-cached
		// EDID lookups (best-known candidate spellings); both failing degrades
		// honestly - the caller reports the toggle unavailable with the reason.
		RE::SpellItem* LearnToggleSpell(std::string* whyNot = nullptr)
		{
			if (auto obj = QuestObj()) {
				if (auto* bookForm = VarForm(ScriptVar(obj.get(), "TomeOfSC"), RE::FormType::Book)) {
					if (auto bookObj = BindScript(bookForm, kBookScript)) {
						if (auto* f = VarForm(ScriptVar(bookObj.get(), "LearnEffectsSpell"), RE::FormType::Spell))
							return f->As<RE::SpellItem>();
					}
				}
			}
			for (const char* edid : { "LearnEffectsSpell", "EM03LearnEffectsSpell" }) {
				if (auto* sp = RE::TESForm::LookupByEditorID<RE::SpellItem>(edid))
					return sp;
			}
			if (whyNot)
				*whyNot = "FESC's learn-effects ability couldn't be resolved - mod updated?";
			return nullptr;
		}

		// ------------------------------------------------------ SEH inventory --
		// finance.cpp's lesson verbatim: sum only the matching entries in
		// InventoryChanges, SEH-wrapped - the full inventory rebuild has faulted
		// on this 4,000-plugin load order. countDelta covers everything acquired
		// at runtime, which is where gold and the crafting tome both live.

		__declspec(noinline) std::int64_t CountItemRaw(RE::FormID id)
		{
			auto* p = RE::PlayerCharacter::GetSingleton();
			if (!p)
				return 0;
			std::int64_t total = 0;
			auto*        changes = p->GetInventoryChanges();
			if (changes && changes->entryList) {
				for (auto* entry : *changes->entryList) {
					if (entry && entry->object && entry->object->GetFormID() == id)
						total += entry->countDelta;
				}
			}
			return total;
		}

		std::int64_t CountItem(RE::FormID id)
		{
			__try {
				return CountItemRaw(id);
			} __except (EXCEPTION_EXECUTE_HANDLER) {
				return -1;  // sentinel: view shows "?" rather than a lie
			}
		}

		std::int64_t ReadGold()
		{
			return CountItem(kGold);
		}

		bool HasTome()
		{
			if (auto obj = QuestObj()) {
				if (auto* book = VarForm(ScriptVar(obj.get(), "TomeOfSC"), RE::FormType::Book))
					return CountItem(book->GetFormID()) > 0;
			}
			return false;
		}

		// ------------------------------------------------------------ schools --

		// FESC's five-school order - the same order its 25-slot BaseEffects and
		// SpellPerks tables are laid out in (5 schools x 5 tiers).
		int SchoolIndexOf(RE::ActorValue av)
		{
			using AV = RE::ActorValue;
			switch (av) {
			case AV::kAlteration:  return 0;
			case AV::kConjuration: return 1;
			case AV::kDestruction: return 2;
			case AV::kIllusion:    return 3;
			case AV::kRestoration: return 4;
			default:               return -1;
			}
		}

		const char* SchoolName(RE::ActorValue av)
		{
			switch (SchoolIndexOf(av)) {
			case 0: return "alteration";
			case 1: return "conjuration";
			case 2: return "destruction";
			case 3: return "illusion";
			case 4: return "restoration";
			default: return "none";
			}
		}

		// The school of a whole spell = its costliest effect's associated skill,
		// which is how the engine files it too.
		const char* SpellSchoolName(RE::SpellItem* s)
		{
			if (!s)
				return "none";
			const auto* eff = s->GetCostliestEffectItem();
			if (!eff || !eff->baseEffect)
				return "none";
			return SchoolName(eff->baseEffect->data.associatedSkill);
		}

		// ------------------------------------------------------------ sidecar --

		std::filesystem::path SidecarPath()
		{
			return std::filesystem::path("Data") / "SKSE" / "Plugins" / "HotkeyDeck" / "spellcraft.json";
		}

		// Whole root kept and rewritten, so unknown keys a future build adds to
		// the sidecar survive an old build's write.
		json LoadSidecar()
		{
			std::ifstream in(SidecarPath(), std::ios::binary);
			if (!in)
				return json::object();
			const auto j = json::parse(in, nullptr, false);
			return (j.is_discarded() || !j.is_object()) ? json::object() : j;
		}

		void SaveSidecar(const json& root)
		{
			const auto path = SidecarPath();
			std::error_code ec;
			std::filesystem::create_directories(path.parent_path(), ec);
			auto tmp = path;
			tmp += ".tmp";
			{
				std::ofstream out(tmp, std::ios::trunc | std::ios::binary);
				if (!out.is_open()) {
					logger::warn("spellcraft: could not write {}", PathU8(tmp));
					return;
				}
				out << Dump(root);
			}
			std::filesystem::rename(tmp, path, ec);
			if (ec)
				logger::warn("spellcraft: sidecar rename failed: {}", ec.message());
		}

		// main.cpp's ValidViewIconPath rule, replicated (the original is a
		// main.cpp static): view-relative, forward slashes, under icons/, no
		// escapes. "" (no icon) is always valid so clearing works.
		bool ValidIconPath(std::string& p)
		{
			std::replace(p.begin(), p.end(), '\\', '/');
			if (p.empty())
				return true;
			if (p.find("..") != std::string::npos || p.front() == '/' || p.find(':') != std::string::npos)
				return false;
			return p.compare(0, 6, "icons/") == 0;
		}

		// ------------------------------------------------------------ pending --
		// Craft/Settings/Tome validate in-pane and ARM the real work; main.cpp
		// closes the palette and calls RunPending() ~200ms later (Papyrus runs
		// unpaused only - the party-orders law). Main-thread only.
		std::function<void()> g_pending;

		void ArmPending(std::function<void()> fn)
		{
			if (g_pending)
				logger::warn("spellcraft: a pending action was overwritten before it ran");
			g_pending = std::move(fn);
		}

		// --------------------------------------------------------- craft plan --

		struct PlanEffect
		{
			RE::EffectSetting* mgef = nullptr;
			RE::SpellItem*     src = nullptr;  // the spell this effect was picked from (may be null)
			std::int32_t       mag = 0;
			std::int32_t       area = 0;
			std::int32_t       dur = 0;
			float              cost = 0.0f;
		};

		struct CraftJob
		{
			std::string             name;
			bool                    isOverride = false;
			std::int32_t            school = 5;  // 0-4, 5 = none (payload spelling)
			RE::SpellItem*          model = nullptr;    // CopyAppearance source + base-spell pick
			RE::EffectSetting*      modelCostFx = nullptr;  // model's costliest MGEF
			std::vector<PlanEffect> effects;
			std::int32_t            costliestEI = 0;
			std::int64_t            goldCost = 0;
			std::int64_t            goldCharged = 0;

			// Override-only, resolved from FESC's own tables at validation:
			RE::SpellItem*            baseSpell = nullptr;  // GetRightBaseSpell result
			RE::EffectSetting*        leadBase = nullptr;   // BaseEffects[BaseEffectIndex]
			int                       perkIndexFallback = 0;
			std::vector<RE::BGSPerk*> spellPerks;           // FESC's 25-slot table

			// Chain state (main-thread writes only):
			RE::SpellItem*     newSpell = nullptr;
			RE::EffectSetting* newEffect = nullptr;
			std::size_t        loopIndex = 0;

			std::atomic<bool>        done{ false };
			std::atomic<bool>        aborted{ false };
			std::atomic<long long>   beatMs{ 0 };
			std::atomic<const char*> stepName{ "start" };
		};

		long long NowMs()
		{
			return std::chrono::duration_cast<std::chrono::milliseconds>(
				std::chrono::steady_clock::now().time_since_epoch()).count();
		}

		void Beat(CraftJob& job, const char* step = nullptr)
		{
			job.beatMs.store(NowMs());
			if (step)
				job.stepName.store(step);
		}

		void RefundGold(std::shared_ptr<CraftJob> job)
		{
			if (job->goldCharged <= 0)
				return;
			auto* player = RE::PlayerCharacter::GetSingleton();
			auto* goldForm = RE::TESForm::LookupByID<RE::TESBoundObject>(kGold);
			if (player && goldForm) {
				player->AddObjectToContainer(goldForm, nullptr,
					static_cast<std::int32_t>(job->goldCharged), nullptr);
				logger::info("spellcraft: refunded {} gold after abort", job->goldCharged);
			} else {
				logger::warn("spellcraft: could NOT refund {} gold (player/gold form missing)",
					job->goldCharged);
			}
			job->goldCharged = 0;
		}

		// Main thread. Ends the chain honestly: refund, HUD, log, done.
		void AbortJob(std::shared_ptr<CraftJob> job, const std::string& why)
		{
			if (job->done.load() || job->aborted.load())
				return;
			job->aborted.store(true);
			RefundGold(job);
			const std::string note = "Spell crafting failed - " + why + " - nothing was taught";
			RE::DebugNotification(note.c_str());
			logger::warn("spellcraft: chain aborted at '{}': {}", job->stepName.load(), why);
			job->done.store(true);
		}

		// One VM answer -> the next chain step, hopped to the main thread first
		// (the mhiyh BoolResult discipline: nothing the VM thread hands us may
		// touch the view or live game state where it lands).
		class ChainStep : public RE::BSScript::IStackCallbackFunctor
		{
		public:
			ChainStep(std::shared_ptr<CraftJob> job,
				std::function<void(RE::BSScript::Variable)> next) :
				_job(std::move(job)), _next(std::move(next))
			{}

			void operator()(RE::BSScript::Variable a_result) override
			{
				auto job = _job;
				auto next = _next;
				auto* task = SKSE::GetTaskInterface();
				if (!task || !job)
					return;
				// COMPILE-CHECK: BSScript::Variable is copyable; the lambda
				// carries it by value into the task queue.
				task->AddTask([job, next, a_result]() mutable {
					if (job->done.load() || job->aborted.load())
						return;
					Beat(*job);
					if (next)
						next(std::move(a_result));
				});
			}

			bool CanSave() const override { return false; }
			void SetObject(const RE::BSTSmartPointer<RE::BSScript::Object>&) override {}

		private:
			std::shared_ptr<CraftJob>                   _job;
			std::function<void(RE::BSScript::Variable)> _next;
		};

		// Dispatch one DynamicPersistentForms static with the next step chained
		// on its callback. False (and an AbortJob) when the VM refuses.
		template <class... Args>
		bool DpfCall(std::shared_ptr<CraftJob> job, const char* fn, const char* step,
			std::function<void(RE::BSScript::Variable)> next, Args&&... args)
		{
			auto* vm = Vm();
			if (!vm) {
				AbortJob(job, "the Papyrus VM is gone");
				return false;
			}
			Beat(*job, step);
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb(
				new ChainStep(job, std::move(next)));
			auto fnArgs = RE::MakeFunctionArguments(std::forward<Args>(args)...);
			if (!vm->DispatchStaticCall(kDpfClass, fn, fnArgs, cb)) {
				AbortJob(job, std::string("DynamicPersistentForms.") + fn +
									" refused to dispatch - is Dynamic Persistent Forms installed?");
				return false;
			}
			return true;
		}

		// The 10s per-step watchdog (keys_scan's timeout discipline): a VM that
		// stopped answering must abort the chain out loud, not hang it silently.
		void StartWatchdog(std::shared_ptr<CraftJob> job)
		{
			Beat(*job);
			std::thread([job]() {
				for (;;) {
					std::this_thread::sleep_for(std::chrono::milliseconds(500));
					if (job->done.load())
						return;
					if (NowMs() - job->beatMs.load() > 10000) {
						if (auto* task = SKSE::GetTaskInterface()) {
							task->AddTask([job]() {
								AbortJob(job, std::string("step '") + job->stepName.load() +
													"' never answered (10s)");
							});
						}
						return;
					}
				}
			}).detach();
		}

		// ------------------------------------------------- the override chain --
		// Their decompiled override branch, step for step. Forward declarations
		// because each step's callback names the next.

		void StepCopyAppearanceSpell(std::shared_ptr<CraftJob> job);
		void StepClearEffects(std::shared_ptr<CraftJob> job);
		void StepCreateLead(std::shared_ptr<CraftJob> job);
		void StepCopyAppearanceLead(std::shared_ptr<CraftJob> job);
		void StepAddLead(std::shared_ptr<CraftJob> job);
		void StepAddLoop(std::shared_ptr<CraftJob> job);
		void StepPerk(std::shared_ptr<CraftJob> job);
		void StepTeach(std::shared_ptr<CraftJob> job);

		void StartOverrideChain(std::shared_ptr<CraftJob> job)
		{
			StartWatchdog(job);
			// S1: NewSpell = DynamicPersistentForms.Create(GetRightBaseSpell(...))
			DpfCall(job, "Create", "Create(spell)",
				[job](RE::BSScript::Variable result) {
					auto* form = FormFromResult(std::move(result), RE::FormType::Spell);
					job->newSpell = form ? form->As<RE::SpellItem>() : nullptr;
					if (!job->newSpell) {
						AbortJob(job, "DPF Create returned no spell");
						return;
					}
					StepCopyAppearanceSpell(job);
				},
				std::move(static_cast<RE::SpellItem*>(job->baseSpell)));
		}

		void StepCopyAppearanceSpell(std::shared_ptr<CraftJob> job)
		{
			DpfCall(job, "CopyAppearance", "CopyAppearance(spell)",
				[job](RE::BSScript::Variable) {
					// Engine-side: the spell's display name. TESFullName is a
					// public BSFixedString member; a runtime write is exactly
					// what FESC's own SetName native does.
					if (auto* fn = job->newSpell->As<RE::TESFullName>())
						fn->fullName = RE::BSFixedString(job->name);
					StepClearEffects(job);
				},
				std::move(static_cast<RE::SpellItem*>(job->model)),
				std::move(static_cast<RE::SpellItem*>(job->newSpell)));
		}

		void StepClearEffects(std::shared_ptr<CraftJob> job)
		{
			DpfCall(job, "ClearMagicEffects", "ClearMagicEffects",
				[job](RE::BSScript::Variable) { StepCreateLead(job); },
				std::move(static_cast<RE::SpellItem*>(job->newSpell)));
		}

		void StepCreateLead(std::shared_ptr<CraftJob> job)
		{
			// The custom lead effect is added FIRST so it lands as effects[0]:
			// the FESC DLL's kPostLoadGame fixup re-applies delivery/castingType
			// to effects[0] named "EM03ID_" - that invariant is load-bearing.
			DpfCall(job, "Create", "Create(effect)",
				[job](RE::BSScript::Variable result) {
					auto* form = FormFromResult(std::move(result), RE::FormType::MagicEffect);
					job->newEffect = form ? form->As<RE::EffectSetting>() : nullptr;
					if (!job->newEffect) {
						AbortJob(job, "DPF Create returned no magic effect");
						return;
					}
					StepCopyAppearanceLead(job);
				},
				std::move(static_cast<RE::EffectSetting*>(job->leadBase)));
		}

		void StepCopyAppearanceLead(std::shared_ptr<CraftJob> job)
		{
			DpfCall(job, "CopyAppearance", "CopyAppearance(effect)",
				[job](RE::BSScript::Variable) {
					// Engine-side replacement for their SetEffectStuff native
					// (the null-menu-global CTD): stamp the model's delivery and
					// casting type onto the lead effect, and give it the marker
					// name their post-load fixup keys on.
					auto* fx = job->newEffect;
					fx->data.delivery = job->model->GetDelivery();
					fx->data.castingType = job->model->GetCastingType();
					if (auto* fn = fx->As<RE::TESFullName>())
						fn->fullName = RE::BSFixedString("EM03ID_");
					StepAddLead(job);
				},
				std::move(static_cast<RE::EffectSetting*>(job->modelCostFx)),
				std::move(static_cast<RE::EffectSetting*>(job->newEffect)));
		}

		void StepAddLead(std::shared_ptr<CraftJob> job)
		{
			const auto& lead = job->effects[static_cast<std::size_t>(job->costliestEI)];
			DpfCall(job, "AddMagicEffect", "AddMagicEffect(lead)",
				[job](RE::BSScript::Variable) {
					// Their script then zeroes the source slot's cost (the lead
					// carried it) and loops over EVERY picked effect.
					job->effects[static_cast<std::size_t>(job->costliestEI)].cost = 0.0f;
					job->loopIndex = 0;
					StepAddLoop(job);
				},
				std::move(static_cast<RE::SpellItem*>(job->newSpell)),
				std::move(static_cast<RE::EffectSetting*>(job->newEffect)),
				std::move(0.0f),
				std::move(static_cast<std::int32_t>(lead.area)),
				std::move(static_cast<std::int32_t>(0)),
				std::move(static_cast<float>(lead.cost)));
		}

		void StepAddLoop(std::shared_ptr<CraftJob> job)
		{
			if (job->loopIndex >= job->effects.size()) {
				StepPerk(job);
				return;
			}
			const auto& e = job->effects[job->loopIndex];
			++job->loopIndex;
			DpfCall(job, "AddMagicEffect", "AddMagicEffect(loop)",
				[job](RE::BSScript::Variable) { StepAddLoop(job); },
				std::move(static_cast<RE::SpellItem*>(job->newSpell)),
				std::move(static_cast<RE::EffectSetting*>(e.mgef)),
				std::move(static_cast<float>(e.mag)),
				std::move(static_cast<std::int32_t>(e.area)),
				std::move(static_cast<std::int32_t>(e.dur)),
				std::move(static_cast<float>(e.cost)));
		}

		void StepPerk(std::shared_ptr<CraftJob> job)
		{
			// Their GetRigtPerk reads effects[0]'s associated skill + skill
			// level. effects[0] IS job->newEffect, whose data derives from
			// BaseEffects[BaseEffectIndex] - read it live, fall back to the
			// parallel-table index computed at validation when the skill is
			// unmapped (BaseEffects and SpellPerks are parallel 25-slot tables).
			int idx = job->perkIndexFallback;
			if (job->newEffect) {
				const int base = SchoolIndexOf(job->newEffect->data.associatedSkill);
				if (base >= 0) {
					// COMPILE-CHECK: EffectSettingData::minimumSkill (int32).
					const int lvl = static_cast<int>(job->newEffect->data.minimumSkill);
					idx = std::clamp(base * 5 + lvl / 25, 0, 24);
				}
			}
			RE::BGSPerk* perk =
				(idx >= 0 && idx < static_cast<int>(job->spellPerks.size())) ? job->spellPerks[static_cast<std::size_t>(idx)] : nullptr;
			if (!perk) {
				logger::warn("spellcraft: no casting perk at slot {} - skipping SetSpellCastingPerk", idx);
				StepTeach(job);
				return;
			}
			DpfCall(job, "SetSpellCastingPerk", "SetSpellCastingPerk",
				[job](RE::BSScript::Variable) { StepTeach(job); },
				std::move(static_cast<RE::SpellItem*>(job->newSpell)),
				std::move(static_cast<RE::BGSPerk*>(perk)));
		}

		void StepTeach(std::shared_ptr<CraftJob> job)
		{
			// The LAST link on purpose: everything before this can abort and the
			// player has lost nothing but refunded gold.
			auto* player = RE::PlayerCharacter::GetSingleton();
			if (!player || !job->newSpell) {
				AbortJob(job, "the player vanished before the spell could be taught");
				return;
			}
			player->AddSpell(job->newSpell);
			job->done.store(true);
			const std::string note = "Crafted " + job->name;
			RE::DebugNotification(note.c_str());
			logger::info("spellcraft: override chain complete - '{}' taught ({:08X}, {} effects)",
				job->name, job->newSpell->GetFormID(), job->effects.size());
		}

		// -------------------------------------------- non-override dispatch --

		// Fire-and-forget completion logger: their script owns gold, notify and
		// the Book Menu force-close (harmless, none open); we only record that
		// the VM finished the call.
		class LogResult : public RE::BSScript::IStackCallbackFunctor
		{
		public:
			explicit LogResult(std::string what) :
				_what(std::move(what)) {}
			void operator()(RE::BSScript::Variable) override
			{
				logger::info("spellcraft: {} returned", _what);
			}
			bool CanSave() const override { return false; }
			void SetObject(const RE::BSTSmartPointer<RE::BSScript::Object>&) override {}

		private:
			std::string _what;
		};

		template <class... Args>
		bool CallQuestMethod(const char* fn, Args&&... args)
		{
			auto* vm = Vm();
			auto* quest = FescQuest();
			if (!vm || !quest)
				return false;
			auto* policy = vm->GetObjectHandlePolicy();
			if (!policy)
				return false;
			const auto handle = policy->GetHandleForObject(RE::TESQuest::FORMTYPE, quest);
			if (handle == policy->EmptyHandle())
				return false;
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb(
				new LogResult(std::string(kQuestScript) + "." + fn));
			auto fnArgs = RE::MakeFunctionArguments(std::forward<Args>(args)...);
			return vm->DispatchMethodCall(handle, kQuestScript, fn, fnArgs, cb);
		}

		void RunCraftDispatch(std::shared_ptr<CraftJob> job)
		{
			// Build marker (hd-markers.json: "spellcraft-craft").
			logger::info("spellcraft: craft '{}' - {} effects, override={}, gold {}",
				job->name, job->effects.size(), job->isOverride, job->goldCost);

			auto* player = RE::PlayerCharacter::GetSingleton();
			if (!player) {
				RE::DebugNotification("Spell crafting failed - no player");
				return;
			}

			// Re-check gold at fire time (validation was a palette-close ago).
			if (job->goldCost > 0) {
				const auto gold = ReadGold();
				if (gold >= 0 && gold < job->goldCost) {
					const std::string note = "Spell crafting refused - you carry " +
						std::to_string(gold) + " gold, this spell costs " + std::to_string(job->goldCost);
					RE::DebugNotification(note.c_str());
					logger::info("spellcraft: gold went short between arm and fire");
					return;
				}
			}

			if (!job->isOverride) {
				// Their script verbatim - it charges the gold itself (the
				// pre-check above only guarantees its MessageBox refusal can't
				// fire), picks the base spell, DPF-creates, adds every effect,
				// sets the casting perk, AddSpell, and force-closes Book Menu.
				std::vector<RE::EffectSetting*> fx;
				std::vector<std::int32_t>       mag, area, dur;
				std::vector<float>              cost;
				for (const auto& e : job->effects) {
					fx.push_back(e.mgef);
					mag.push_back(e.mag);
					area.push_back(e.area);
					dur.push_back(e.dur);
					cost.push_back(e.cost);
				}
				RE::BSFixedString nm(job->name);
				// COMPILE-CHECK: std::vector packing through MakeFunctionArguments
				// (CommonLibSSE-NG PackValue's array support). If the overload is
				// missing, arrays must be built as BSScript::Array via the VM's
				// type info and packed into Variables by hand.
				const bool sent = CallQuestMethod("CraftTheSpell",
					std::move(nm),
					std::move(fx),
					std::move(mag),
					std::move(area),
					std::move(dur),
					std::move(static_cast<std::int32_t>(job->school)),
					std::move(cost),
					std::move(static_cast<RE::SpellItem*>(job->model)),
					std::move(static_cast<std::int32_t>(job->costliestEI)),
					std::move(false));
				if (!sent) {
					RE::DebugNotification("Spell crafting failed - FESC didn't answer");
					logger::warn("spellcraft: CraftTheSpell dispatch refused");
				}
				return;
			}

			// Override: OUR mirror. Charge the gold first (their branch does),
			// refunded by AbortJob if the chain dies.
			if (job->goldCost > 0) {
				auto* goldForm = RE::TESForm::LookupByID<RE::TESBoundObject>(kGold);
				if (!goldForm) {
					RE::DebugNotification("Spell crafting failed - gold form missing");
					return;
				}
				player->RemoveItem(goldForm, static_cast<std::int32_t>(job->goldCost),
					RE::ITEM_REMOVE_REASON::kRemove, nullptr, nullptr);
				job->goldCharged = job->goldCost;
			}
			StartOverrideChain(job);
		}

		// ------------------------------------------------------ open snapshot --

		struct FxRow
		{
			std::string   name;
			std::string   mgefPlugin;
			std::uint32_t mgefLocalId = 0;
			float         mag = 0.0f;
			std::int32_t  area = 0;
			std::int32_t  dur = 0;
			std::int32_t  ogDur = 0;
			std::int32_t  ogArea = 0;
			double        D = 0.0;
			bool          noMag = false;
			bool          noArea = false;
			bool          noDur = false;
			bool          hostile = false;
			bool          gated = false;
			std::string   school;
			std::int32_t  skillLvl = 0;
			std::int32_t  delivery = 0;
			std::int32_t  casting = 0;
		};

		struct SpellRow
		{
			std::string        plugin;
			std::uint32_t      localId = 0;
			std::uint32_t      formId = 0;
			std::string        name;
			std::string        school;
			std::int32_t       delivery = 0;
			std::int32_t       casting = 0;
			std::vector<FxRow> effects;
		};

		struct AlchRow
		{
			std::string   name;
			std::string   plugin;
			std::uint32_t localId = 0;
			double        D = 0.0;
			std::int32_t  delivery = 0;
			std::int32_t  casting = 0;
			bool          hostile = false;
		};

		struct CraftedRow
		{
			std::string              plugin;
			std::uint32_t            localId = 0;
			std::uint32_t            formId = 0;
			std::string              name;
			std::string              school;
			std::vector<std::string> effects;
		};

		struct OpenSnap
		{
			bool                    ok = false;
			std::string             reason;
			std::vector<SpellRow>   spells;
			std::vector<AlchRow>    alch;
			std::vector<CraftedRow> crafted;
			bool                    learnMode = false;
			bool                    hasTome = false;
			std::int64_t            gold = 0;
			SettingsSnap            settings;
		};

		bool MgefFlag(const RE::EffectSetting* m, RE::EffectSetting::EffectSettingData::Flag f)
		{
			return m && m->data.flags.any(f);
		}

		FxRow FxRowOf(RE::Effect* eff, RE::SpellItem* spell, const SettingsSnap& st,
			RE::PlayerCharacter* player)
		{
			using Flag = RE::EffectSetting::EffectSettingData::Flag;
			FxRow row;
			auto* base = eff->baseEffect;
			row.name = NameOf(base);
			if (row.name.empty()) {
				if (const char* eid = base->GetFormEditorID(); eid && *eid)
					row.name = eid;
			}
			row.mgefPlugin = PluginOf(base);
			row.mgefLocalId = ActorIdentity::LocalIdOf(base);
			row.noMag = MgefFlag(base, Flag::kNoMagnitude);
			row.noArea = MgefFlag(base, Flag::kNoArea);
			row.noDur = MgefFlag(base, Flag::kNoDuration);
			row.hostile = MgefFlag(base, Flag::kHostile);
			row.mag = eff->effectItem.magnitude;
			// og* keep the AUTHORED values; area/dur are zeroed where the
			// effect's own flags say the axis is meaningless, so the crafting
			// sliders start honest.
			row.ogArea = static_cast<std::int32_t>(eff->effectItem.area);
			row.ogDur = static_cast<std::int32_t>(eff->effectItem.duration);
			row.area = row.noArea ? 0 : row.ogArea;
			row.dur = row.noDur ? 0 : row.ogDur;
			row.school = SchoolName(base->data.associatedSkill);
			row.skillLvl = static_cast<std::int32_t>(base->data.minimumSkill);
			row.delivery = static_cast<std::int32_t>(base->data.delivery);
			row.casting = static_cast<std::int32_t>(base->data.castingType);
			// D = the per-effect base cost their sliders price from, recovered
			// with the mod's exact math; falls back to 0 when the mgef carries
			// no base cost to recover against.
			if (base->data.baseCost > 0.01f) {
				const float m = std::max(row.mag, 1.0f);
				const float d = std::max(static_cast<float>(row.ogDur) / 10.0f, 1.0f);
				row.D = static_cast<double>(eff->cost) / std::pow(static_cast<double>(m * d), 1.1);
			}
			// The MustKnowPerk gate, exactly as FESC's own menu evaluates it.
			row.gated = st.mustKnowPerk &&
			            spell->GetDelivery() == RE::MagicSystem::Delivery::kSelf &&
			            player && !eff->conditions.IsTrue(player, player);
			return row;
		}

		// The engine pass - main thread ONLY (see the header's choice note).
		OpenSnap CollectOpenSnap()
		{
			OpenSnap snap;
			snap.settings = ReadSettings();
			if (!snap.settings.ok) {
				snap.reason = snap.settings.reason;
				return snap;
			}
			auto* player = RE::PlayerCharacter::GetSingleton();
			auto* dh = RE::TESDataHandler::GetSingleton();
			if (!player || !dh) {
				snap.reason = "no game loaded";
				return snap;
			}
			snap.ok = true;
			snap.gold = ReadGold();
			snap.hasTome = HasTome();
			if (auto* learn = LearnToggleSpell())
				snap.learnMode = player->HasSpell(learn);

			const std::string dpfLower = Lower(kDpfPlugin);

			// Every SpellType::kSpell the player knows - the dataHandler array
			// filtered by HasSpell, which mirrors the mod's own menu source.
			for (auto* s : dh->GetFormArray<RE::SpellItem>()) {
				if (!s || s->GetSpellType() != RE::MagicSystem::SpellType::kSpell)
					continue;
				const char* nm = s->GetName();
				if (!nm || !*nm)
					continue;  // nameless = internal junk, unofferable
				const std::string plugin = PluginOf(s);
				if (plugin.empty())
					continue;  // dynamic - not durable, not listable
				if (!player->HasSpell(s))
					continue;
				SpellRow row;
				row.plugin = plugin;
				row.localId = ActorIdentity::LocalIdOf(s);
				row.formId = s->GetFormID();
				row.name = nm;
				row.school = SpellSchoolName(s);
				row.delivery = static_cast<std::int32_t>(s->GetDelivery());
				row.casting = static_cast<std::int32_t>(s->GetCastingType());
				for (auto* eff : s->effects) {
					if (!eff || !eff->baseEffect)
						continue;
					row.effects.push_back(FxRowOf(eff, s, snap.settings, player));
				}
				if (!row.effects.empty())
					snap.spells.push_back(std::move(row));
			}

			// Alchemy-learned effects: FESC's own LearnedEffects array.
			if (auto obj = QuestObj()) {
				auto forms = VarFormArray(ScriptVar(obj.get(), "LearnedEffects"),
					RE::FormType::MagicEffect);
				const auto count = VarInt(ScriptVar(obj.get(), "EffectCount"),
					static_cast<std::int32_t>(forms.size()));
				const auto n = std::min<std::size_t>(forms.size(),
					count > 0 ? static_cast<std::size_t>(count) : forms.size());
				for (std::size_t i = 0; i < n; ++i) {
					auto* m = forms[i] ? forms[i]->As<RE::EffectSetting>() : nullptr;
					if (!m)
						continue;
					AlchRow row;
					row.name = NameOf(m);
					if (row.name.empty())
						continue;
					row.plugin = PluginOf(m);
					row.localId = ActorIdentity::LocalIdOf(m);
					row.D = m->data.baseCost;
					row.delivery = static_cast<std::int32_t>(m->data.delivery);
					row.casting = static_cast<std::int32_t>(m->data.castingType);
					row.hostile = MgefFlag(m, RE::EffectSetting::EffectSettingData::Flag::kHostile);
					snap.alch.push_back(std::move(row));
				}
			}

			// Crafted = added spells whose owning file is DPF.esp (DPF RE's
			// allocation plugin - every FESC creation lives there).
			for (auto* s : player->GetActorRuntimeData().addedSpells) {
				if (!s || Lower(PluginOf(s)) != dpfLower)
					continue;
				CraftedRow row;
				row.plugin = PluginOf(s);
				row.localId = ActorIdentity::LocalIdOf(s);
				row.formId = s->GetFormID();
				row.name = NameOf(s);
				row.school = SpellSchoolName(s);
				for (auto* eff : s->effects) {
					if (eff && eff->baseEffect) {
						auto nm = NameOf(eff->baseEffect);
						if (!nm.empty())
							row.effects.push_back(std::move(nm));
					}
				}
				snap.crafted.push_back(std::move(row));
			}
			return snap;
		}

		json FxRowJson(const FxRow& e)
		{
			return json{
				{ "name", e.name },
				{ "mgefPlugin", e.mgefPlugin },
				{ "mgefLocalId", e.mgefLocalId },
				{ "mag", e.mag },
				{ "area", e.area },
				{ "dur", e.dur },
				{ "D", e.D },
				{ "ogDur", e.ogDur },
				{ "ogArea", e.ogArea },
				{ "noMag", e.noMag },
				{ "noArea", e.noArea },
				{ "noDur", e.noDur },
				{ "hostile", e.hostile },
				{ "school", e.school },
				{ "skillLvl", e.skillLvl },
				{ "delivery", e.delivery },
				{ "casting", e.casting },
				{ "gated", e.gated },
			};
		}

		// Pure data -> JSON. Runs on the WORKER thread - it must not touch a
		// form, the VM or the player; everything it needs is in the snapshot.
		std::string SerializeOpenSnap(const OpenSnap& snap)
		{
			if (!snap.ok)
				return Dump(json{ { "ok", false }, { "reason", snap.reason } });
			json spells = json::array();
			for (const auto& s : snap.spells) {
				json fx = json::array();
				for (const auto& e : s.effects)
					fx.push_back(FxRowJson(e));
				spells.push_back(json{
					{ "plugin", s.plugin },
					{ "localId", s.localId },
					{ "formId", s.formId },
					{ "name", s.name },
					{ "school", s.school },
					{ "delivery", s.delivery },
					{ "casting", s.casting },
					{ "effects", std::move(fx) },
				});
			}
			json alch = json::array();
			for (const auto& a : snap.alch) {
				alch.push_back(json{
					{ "name", a.name },
					{ "plugin", a.plugin },
					{ "localId", a.localId },
					{ "D", a.D },
					{ "delivery", a.delivery },
					{ "casting", a.casting },
					{ "school", "none" },
					{ "hostile", a.hostile },
				});
			}
			json crafted = json::array();
			for (const auto& c : snap.crafted) {
				crafted.push_back(json{
					{ "plugin", c.plugin },
					{ "localId", c.localId },
					{ "formId", c.formId },
					{ "name", c.name },
					{ "school", c.school },
					{ "effects", c.effects },
				});
			}
			// The icon sidecar is file IO only - safe off-thread.
			json icons = json::object();
			{
				const auto root = LoadSidecar();
				if (root.contains("icons") && root["icons"].is_object())
					icons = root["icons"];
			}
			return Dump(json{
				{ "ok", true },
				{ "spells", std::move(spells) },
				{ "alch", std::move(alch) },
				{ "crafted", std::move(crafted) },
				{ "icons", std::move(icons) },
				{ "learnMode", snap.learnMode },
				{ "hasTome", snap.hasTome },
				{ "gold", snap.gold },
				{ "settings", SettingsJson(snap.settings) },
			});
		}
	}

	// ================================================================== API ==

	std::string StateJson()
	{
		const auto st = ReadSettings();
		json j;
		j["present"] = st.ok;
		if (!st.ok)
			j["reason"] = st.reason;
		j["dpfPex"] = DpfAvailable();
		j["gold"] = ReadGold();
		bool learnMode = false, hasTome = false;
		if (st.ok) {
			hasTome = HasTome();
			if (auto* player = RE::PlayerCharacter::GetSingleton()) {
				if (auto* learn = LearnToggleSpell())
					learnMode = player->HasSpell(learn);
			}
		}
		j["learnMode"] = learnMode;
		j["hasTome"] = hasTome;
		j["settings"] = SettingsJson(st);
		logger::info("spellcraft: state present={} dpf={} tome={}", st.ok, DpfAvailable(), hasTome);
		return Dump(j);
	}

	void Open(std::function<void(std::string)> deliver)
	{
		if (!deliver)
			return;
		// Engine pass HERE (the caller's main-thread task); the worker only
		// serialises the copied plain data - see the header's choice note.
		auto snap = std::make_shared<OpenSnap>(CollectOpenSnap());
		logger::info("spellcraft: open snapshot - {} spells, {} alch effects, {} crafted",
			snap->spells.size(), snap->alch.size(), snap->crafted.size());
		std::thread([snap, deliver = std::move(deliver)]() {
			// Catch-all: an exception on a detached thread is a CTD (the
			// anim-scan lesson), and a mod's mangled name must cost one payload,
			// not the process.
			std::string payload;
			try {
				payload = SerializeOpenSnap(*snap);
			} catch (const std::exception& e) {
				payload = Dump(json{ { "ok", false },
					{ "reason", std::string("snapshot serialisation failed: ") + e.what() } });
			} catch (...) {
				payload = Dump(json{ { "ok", false }, { "reason", "snapshot serialisation failed" } });
			}
			if (auto* task = SKSE::GetTaskInterface())
				task->AddTask([deliver, payload = std::move(payload)]() { deliver(payload); });
		}).detach();
	}

	std::string Craft(const std::string& req, bool& closingOut)
	{
		closingOut = false;
		auto refuse = [](const std::string& msg) {
			return Dump(json{ { "ok", false }, { "msg", msg }, { "closing", false } });
		};

		json in = json::object();
		try {
			in = json::parse(req);
		} catch (...) {}
		if (!in.is_object())
			return refuse("Malformed craft payload");

		const auto st = ReadSettings();
		if (!st.ok)
			return refuse(st.reason);
		if (!DpfAvailable())
			return refuse("Dynamic Persistent Forms isn't answering - crafting needs DPF");

		auto job = std::make_shared<CraftJob>();
		job->name = in.value("name", std::string(""));
		while (!job->name.empty() && (job->name.back() == ' ' || job->name.back() == '\t'))
			job->name.pop_back();
		if (job->name.empty())
			return refuse("Give the spell a name first");
		job->isOverride = in.value("override", false);
		job->school = in.value("school", 5);

		if (!in.contains("effects") || !in["effects"].is_array() || in["effects"].empty())
			return refuse("Add at least one effect");
		if (in["effects"].size() > 24)
			return refuse("That is too many effects for one spell");

		for (const auto& e : in["effects"]) {
			if (!e.is_object())
				return refuse("Malformed effect row");
			PlanEffect pe;
			if (e.contains("mgef") && e["mgef"].is_object()) {
				pe.mgef = ResolveForm<RE::EffectSetting>(
					e["mgef"].value("plugin", std::string("")), e["mgef"].value("localId", 0u));
			}
			if (!pe.mgef)
				return refuse("One of the picked effects isn't in the load order any more");
			if (e.contains("srcSpell") && e["srcSpell"].is_object()) {
				pe.src = ResolveForm<RE::SpellItem>(
					e["srcSpell"].value("plugin", std::string("")), e["srcSpell"].value("localId", 0u));
			}
			pe.mag = std::max(0, e.value("mag", 0));
			pe.area = std::max(0, e.value("area", 0));
			pe.dur = std::max(0, e.value("dur", 0));
			pe.cost = std::max(0.0f, e.value("cost", 0.0f));
			job->effects.push_back(pe);
		}

		// Costliest-cost effect: first max wins, exactly like a Papyrus loop.
		job->costliestEI = 0;
		for (std::int32_t i = 1; i < static_cast<std::int32_t>(job->effects.size()); ++i) {
			if (job->effects[static_cast<std::size_t>(i)].cost >
				job->effects[static_cast<std::size_t>(job->costliestEI)].cost)
				job->costliestEI = i;
		}
		const auto& costliest = job->effects[static_cast<std::size_t>(job->costliestEI)];

		// Model spell = CopyAppearance source AND base-spell pick.
		if (job->isOverride) {
			if (job->school < 0 || job->school > 4)
				return refuse("Pick a school for the custom effect");
			if (in.contains("overrideBase") && in["overrideBase"].is_object()) {
				job->model = ResolveForm<RE::SpellItem>(
					in["overrideBase"].value("plugin", std::string("")),
					in["overrideBase"].value("localId", 0u));
			}
			if (!job->model)
				return refuse("Pick a base spell for the override");
		} else {
			if (SchoolIndexOf(costliest.mgef->data.associatedSkill) < 0)
				return refuse("The costliest effect has no school - override it with a custom effect");
			job->model = costliest.src;
			if (!job->model)
				return refuse("The costliest effect's source spell is gone - re-pick it");
		}

		auto* modelCost = job->model->GetCostliestEffectItem();
		job->modelCostFx = (modelCost && modelCost->baseEffect) ? modelCost->baseEffect : nullptr;
		if (!job->modelCostFx)
			return refuse("That base spell carries no usable effect");

		// GetRightBaseSpell's index math refuses constant-effect leads: index =
		// (castType-1)*5 + delivery goes NEGATIVE for ConstantEffect (0).
		const auto castType = job->modelCostFx->data.castingType;
		if (castType == RE::MagicSystem::CastingType::kConstantEffect) {
			return refuse(job->isOverride
					? "That base spell is constant-effect - it can't lead a spell, pick another"
					: "A constant-effect can't lead a spell - override it with a custom effect");
		}

		// Gold: GoldCost = sum of int(EffectCost * Cost[i]) - each term
		// TRUNCATED to int before summing, their exact math.
		job->goldCost = 0;
		if (st.effectCost > 0) {
			for (const auto& e : job->effects)
				job->goldCost += static_cast<std::int64_t>(
					static_cast<std::int32_t>(static_cast<float>(st.effectCost) * e.cost));
			const auto gold = ReadGold();
			if (gold >= 0 && gold < job->goldCost)
				return refuse("You carry " + std::to_string(gold) + " gold - this spell costs " +
					std::to_string(job->goldCost));
		}

		// Override-only: resolve everything the chain will need NOW, from
		// FESC's own tables, so the chain never blocks on a VM read mid-flight.
		if (job->isOverride) {
			auto obj = QuestObj();
			if (!obj)
				return refuse("FESC's quest script wouldn't bind");

			bool isHostile = false;
			for (const auto& e : job->effects)
				isHostile = isHostile ||
					MgefFlag(e.mgef, RE::EffectSetting::EffectSettingData::Flag::kHostile);

			const int delivery = static_cast<int>(job->model->GetDelivery());
			int       baseIdx = (static_cast<int>(castType) - 1) * 5 + delivery;
			if (isHostile)
				baseIdx += 10;
			auto baseSpells = VarFormArray(ScriptVar(obj.get(), "BaseSpells"), RE::FormType::Spell);
			if (baseIdx < 0 || baseIdx >= static_cast<int>(baseSpells.size()) ||
				!baseSpells[static_cast<std::size_t>(baseIdx)])
				return refuse("FESC's base-spell table has no entry for that shape of spell");
			job->baseSpell = baseSpells[static_cast<std::size_t>(baseIdx)]->As<RE::SpellItem>();
			if (!job->baseSpell)
				return refuse("FESC's base-spell table entry isn't a spell - mod updated?");

			// HighestSkillLvl: the picked costliest effect's own skill level
			// when it HAS a school, else the model's costliest effect's.
			int lvl = 0;
			if (SchoolIndexOf(costliest.mgef->data.associatedSkill) >= 0)
				lvl = static_cast<int>(costliest.mgef->data.minimumSkill);
			else
				lvl = static_cast<int>(job->modelCostFx->data.minimumSkill);

			const int effIdx = std::clamp(job->school * 5 + lvl / 25, 0, 24);
			auto baseEffects = VarFormArray(ScriptVar(obj.get(), "BaseEffects"),
				RE::FormType::MagicEffect);
			if (effIdx >= static_cast<int>(baseEffects.size()) ||
				!baseEffects[static_cast<std::size_t>(effIdx)])
				return refuse("FESC's base-effect table has no entry for that school and level");
			job->leadBase = baseEffects[static_cast<std::size_t>(effIdx)]->As<RE::EffectSetting>();
			if (!job->leadBase)
				return refuse("FESC's base-effect table entry isn't a magic effect - mod updated?");
			job->perkIndexFallback = effIdx;

			auto perks = VarFormArray(ScriptVar(obj.get(), "SpellPerks"), RE::FormType::Perk);
			job->spellPerks.reserve(perks.size());
			for (auto* f : perks)
				job->spellPerks.push_back(f ? f->As<RE::BGSPerk>() : nullptr);
		}

		ArmPending([job]() { RunCraftDispatch(job); });
		closingOut = true;
		return Dump(json{ { "ok", true },
			{ "msg", "Crafting " + job->name + (job->goldCost > 0 ? " - " + std::to_string(job->goldCost) + " gold" : "") },
			{ "closing", true } });
	}

	std::string Settings(const std::string& req, bool& closingOut)
	{
		closingOut = false;
		json in = json::object();
		try {
			in = json::parse(req);
		} catch (...) {}

		const auto cur = ReadSettings();
		if (!cur.ok)
			return Dump(json{ { "ok", false }, { "msg", cur.reason }, { "closing", false } });

		const auto tomeCost = std::clamp(in.value("tomeCost", cur.tomeCost), 0, 1000000);
		const auto effectCost = std::clamp(in.value("effectCost", cur.effectCost), 0, 1000000);
		const bool mustKnowPerk = in.value("mustKnowPerk", cur.mustKnowPerk);
		const auto magExp = std::clamp(in.value("magExp", cur.magExp), 0.0f, 10.0f);
		const auto dMult = std::clamp(in.value("dMult", cur.dMult), 0.0f, 100.0f);
		const auto aMult = std::clamp(in.value("aMult", cur.aMult), 0.0f, 100.0f);
		const auto sliderMax = std::clamp(in.value("sliderMax", cur.sliderMax), 1, 10000);
		// FullScreen/ShowOgCost pass through unchanged from the last read.
		const bool fullScreen = g_haveDisplayFlags ? g_lastFullScreen : cur.fullScreen;
		const bool showOgCost = g_haveDisplayFlags ? g_lastShowOgCost : cur.showOgCost;

		ArmPending([=]() {
			const bool sent = CallQuestMethod("ApplySettings",
				std::move(static_cast<std::int32_t>(tomeCost)),
				std::move(static_cast<std::int32_t>(effectCost)),
				std::move(static_cast<bool>(mustKnowPerk)),
				std::move(static_cast<bool>(fullScreen)),
				std::move(static_cast<bool>(showOgCost)),
				std::move(static_cast<float>(magExp)),
				std::move(static_cast<float>(dMult)),
				std::move(static_cast<float>(aMult)),
				std::move(static_cast<std::int32_t>(sliderMax)));
			if (sent) {
				RE::DebugNotification("Spell crafting settings applied");
				logger::info("spellcraft: ApplySettings dispatched (effectCost={}, tomeCost={})",
					effectCost, tomeCost);
			} else {
				RE::DebugNotification("Spell crafting settings failed - FESC didn't answer");
				logger::warn("spellcraft: ApplySettings dispatch refused");
			}
		});
		closingOut = true;
		return Dump(json{ { "ok", true }, { "msg", "Applying settings..." }, { "closing", true } });
	}

	std::string Tome(bool& closingOut)
	{
		closingOut = false;
		const auto cur = ReadSettings();
		if (!cur.ok)
			return Dump(json{ { "ok", false }, { "msg", cur.reason }, { "closing", false } });
		ArmPending([]() {
			if (CallQuestMethod("AddSCTome")) {
				logger::info("spellcraft: AddSCTome dispatched");
			} else {
				RE::DebugNotification("Couldn't add the crafting tome - FESC didn't answer");
				logger::warn("spellcraft: AddSCTome dispatch refused");
			}
		});
		closingOut = true;
		return Dump(json{ { "ok", true }, { "msg", "Adding the crafting tome..." }, { "closing", true } });
	}

	void RunPending()
	{
		if (!g_pending) {
			logger::info("spellcraft: RunPending with nothing armed - ignored");
			return;
		}
		auto fn = std::move(g_pending);
		g_pending = nullptr;
		fn();
	}

	std::string Erase(const std::string& req)
	{
		json in = json::object();
		try {
			in = json::parse(req);
		} catch (...) {}
		auto fail = [](const std::string& msg) {
			return Dump(json{ { "ok", false }, { "msg", msg } });
		};

		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player)
			return fail("No game loaded");
		auto* spell = ResolveForm<RE::SpellItem>(
			in.value("plugin", std::string("")), in.value("localId", 0u));
		if (!spell)
			return fail("That spell isn't in the load order any more");
		const std::string name = NameOf(spell).empty() ? "that spell" : NameOf(spell);
		if (!player->HasSpell(spell))
			return fail("You don't know " + name);

		logger::info("spellcraft: erase '{}' ({:08X})", name, spell->GetFormID());

		// Deliberately NOT their EraseSpell: it calls DynamicPersistentForms.
		// Dispose, which DPF RE does not register (strings dump). Engine-side:
		// clear either hand first so no ghost equip lingers, then RemoveSpell.
		auto unequip = [&](std::int32_t source) {
			auto* vm = Vm();
			if (!vm)
				return;
			auto* policy = vm->GetObjectHandlePolicy();
			if (!policy)
				return;
			const auto handle = policy->GetHandleForObject(RE::Actor::FORMTYPE, player);
			if (handle == policy->EmptyHandle())
				return;
			auto args = RE::MakeFunctionArguments(
				std::move(static_cast<RE::SpellItem*>(spell)), std::move(source));
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			vm->DispatchMethodCall(handle, "Actor", "UnequipSpell", args, cb);
		};
		if (player->GetEquippedObject(true) == spell)
			unequip(0);
		if (player->GetEquippedObject(false) == spell)
			unequip(1);

		if (!player->RemoveSpell(spell) || player->HasSpell(spell))
			return fail(name + " can't be unlearned - racial and starting spells stay");

		// Best-effort Dispose: harmless when DPF RE ignores it, frees the slot
		// if a future DPF build registers it. Failure is expected and ignored.
		if (auto* vm = Vm()) {
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb;
			auto args = RE::MakeFunctionArguments(std::move(static_cast<RE::TESForm*>(spell)));
			if (!vm->DispatchStaticCall(kDpfClass, "Dispose", args, cb))
				logger::info("spellcraft: Dispose not registered (expected under DPF RE)");
		}

		// Drop the sidecar icon so a re-used DPF slot never wears a dead look.
		{
			auto root = LoadSidecar();
			if (root.contains("icons") && root["icons"].is_object()) {
				const auto key = IconKey(in.value("plugin", std::string("")), in.value("localId", 0u));
				if (root["icons"].erase(key) > 0)
					SaveSidecar(root);
			}
		}

		RE::DebugNotification(("Erased " + name).c_str());
		return Dump(json{ { "ok", true }, { "msg", "Erased " + name } });
	}

	std::string Learn(const std::string& req)
	{
		json in = json::object();
		try {
			in = json::parse(req);
		} catch (...) {}
		const bool wantOn = in.value("on", false);

		auto* player = RE::PlayerCharacter::GetSingleton();
		if (!player)
			return Dump(json{ { "ok", false }, { "on", false }, { "msg", "No game loaded" } });
		std::string whyNot;
		auto*       toggle = LearnToggleSpell(&whyNot);
		if (!toggle)
			return Dump(json{ { "ok", false }, { "on", false }, { "msg", whyNot } });

		if (wantOn)
			player->AddSpell(toggle);  // no-op when already carried
		else
			player->RemoveSpell(toggle);
		const bool on = player->HasSpell(toggle);
		logger::info("spellcraft: learn-mode -> {}", on);
		return Dump(json{ { "ok", true }, { "on", on },
			{ "msg", on ? "Learn mode ON - cast spells to learn their effects"
					    : "Learn mode off" } });
	}

	std::string Icon(const std::string& req)
	{
		json in = json::object();
		try {
			in = json::parse(req);
		} catch (...) {}
		const auto plugin = in.value("plugin", std::string(""));
		const auto localId = in.value("localId", 0u);
		auto       icon = in.value("icon", std::string(""));
		if (plugin.empty() || !localId || !ValidIconPath(icon))
			return Dump(json{ { "ok", false } });

		auto root = LoadSidecar();
		if (!root.contains("icons") || !root["icons"].is_object())
			root["icons"] = json::object();
		const auto key = IconKey(plugin, localId);
		if (icon.empty()) {
			root["icons"].erase(key);
		} else {
			if (root["icons"].size() >= kMaxIcons && !root["icons"].contains(key))
				return Dump(json{ { "ok", false } });
			root["icons"][key] = icon;
		}
		SaveSidecar(root);
		return Dump(json{ { "ok", true } });
	}
}
