#include "sos_actions.h"
#include "sos_appearance_model.h"

#include "npc_actions.h"   // TargetFormID: whoever the palette snapshotted

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <functional>
#include <memory>
#include <string>
#include <thread>
#include <vector>

// pch (force-included) provides RE::/SKSE::/logger and, via RE/Skyrim.h,
// <Windows.h> — the same source of INPUT/SendInput/KEYEVENTF main.cpp uses.

// wingdi.h #defines GetObject to GetObjectA, so `variable->GetObject()` fails
// to resolve. Same guard faith.cpp / nff_bridge.cpp carry, for the same reason.
#ifdef GetObject
#	undef GetObject
#endif
#ifdef min
#undef min
#endif
#ifdef max
#undef max
#endif

using namespace std::literals;

namespace SosActions
{
	namespace
	{
		// SOS's own identities, all read out of the source it ships in
		// Scripts\Source — never invented here.
		//   SOS_API.psc:  Game.GetFormFromFile(0x1eda4, "Schlongs of Skyrim.esp")
		//   SOS_API.psc:  SOS_SetupQuest_Script Property SOS  Auto
		//                 ... referenced as SOS.config.iMinSchlongSize
		//   SOS_Config.psc: int property iBendUpKey / iBendDownKey /
		//                   iBendPlayerModifierKey  auto hidden
		constexpr const char*  kPlugin = "Schlongs of Skyrim.esp";
		constexpr std::uint32_t kApiLocalId = 0x1eda4;
		constexpr const char*  kApiScript = "SOS_API";
		constexpr const char*  kConfigProp = "config";
		constexpr const char*  kQuestProp = "SOS";

		// SOS_API.psc: Int Property MIN_SIZE = 4 / MAX_SIZE = 20 are its own
		// hints, but SetSize itself accepts 1..20 ("size > 0 && size < 21").
		// Those are the real bounds, so those are the ones enforced here.
		constexpr int kMinSize = 1;
		constexpr int kMaxSize = 20;

		// SOS's shipped defaults (SOS_Config.psc lines 119-121). Fallback ONLY.
		constexpr std::uint32_t kDefUp = 201;   // PgUp
		constexpr std::uint32_t kDefDown = 209;  // PgDn
		constexpr std::uint32_t kDefMod = 42;   // Left Shift

		// --------------------------------------------------- input synthesis
		// Byte-identical to main.cpp / menu_actions.cpp SendScan.
		void SendScan(std::uint32_t dik, bool down)
		{
			INPUT in{};
			in.type = INPUT_KEYBOARD;
			in.ki.wScan = static_cast<WORD>(dik & 0x7F);
			in.ki.dwFlags = KEYEVENTF_SCANCODE;
			if (dik > 0x7F)
				in.ki.dwFlags |= KEYEVENTF_EXTENDEDKEY;
			if (!down)
				in.ki.dwFlags |= KEYEVENTF_KEYUP;
			SendInput(1, &in, sizeof(INPUT));
		}

		// Hold the modifier (if any), tap the key, release. SOS reads the
		// modifier with IsKeyPressed at the moment its handler runs, so the
		// hold has to still be down when the tap lands — hence the ordering.
		void TapChord(std::uint32_t key, std::uint32_t mod)
		{
			using namespace std::chrono;
			if (!key)
				return;
			if (mod) {
				SendScan(mod, true);
				std::this_thread::sleep_for(milliseconds(15));
			}
			SendScan(key, true);
			std::this_thread::sleep_for(milliseconds(45));
			SendScan(key, false);
			if (mod) {
				std::this_thread::sleep_for(milliseconds(15));
				SendScan(mod, false);
			}
		}

		// -------------------------------------------------------- vm idioms --
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

		// Bind `form`'s instance of the named script, or nullptr. Both casings
		// are tried: Papyrus is case-insensitive and toolchains register the
		// type differently. (Same helper shape as faith.cpp — each module
		// carries its own so none depends on another's internals.)
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

		// An `auto hidden` property has no getter entry; its value lives in the
		// compiler-generated backing variable.
		const RE::BSScript::Variable* Prop(RE::BSScript::Object* obj, const char* name)
		{
			if (!obj || !name)
				return nullptr;
			if (const auto* v = obj->GetProperty(name))
				return v;
			const std::string backing = "::"s + name + "_var";
			return obj->GetVariable(backing);
		}

		// Gate on the type flag: Variable's getters reinterpret a union, so
		// calling the wrong one in a release build reads garbage.
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

		// Follow a Papyrus object-typed property to the script instance it
		// holds. Returns nullptr unless the variable really is an object.
		RE::BSTSmartPointer<RE::BSScript::Object> ObjProp(RE::BSScript::Object* obj, const char* name)
		{
			RE::BSTSmartPointer<RE::BSScript::Object> out;
			const auto*                               v = Prop(obj, name);
			if (!v || !v->IsObject())
				return out;
			out = v->GetObject();
			return out;
		}

		// A scancode SOS could actually be listening for. 0 means "unbound in
		// the MCM", which is a legitimate state and not an error.
		bool SaneCode(int c) { return c > 0 && c <= 265; }

		// ------------------------------------------------------------- size --
		// SOS_API DOES expose size (unlike bend), so grow/shrink calls SOS's own
		// SetSize rather than reimplementing it — the deck implements no
		// mechanic it can borrow.
		class Callback : public RE::BSScript::IStackCallbackFunctor
		{
		public:
			explicit Callback(std::function<void(bool)> fn) : _fn(std::move(fn)) {}
			void operator()(RE::BSScript::Variable a_result) override
			{
				// SOS_API.SetSize returns Bool, so here the result is real.
				const bool ok = a_result.IsBool() && a_result.GetBool();
				auto       fn = _fn;
				if (!fn)
					return;
				if (auto* task = SKSE::GetTaskInterface())
					task->AddTask([fn, ok]() { fn(ok); });
			}
			bool CanSave() const override { return false; }
			void SetObject(const RE::BSTSmartPointer<RE::BSScript::Object>&) override {}

		private:
			std::function<void(bool)> _fn;
		};

		RE::TESForm* ApiForm()
		{
			auto* dh = RE::TESDataHandler::GetSingleton();
			return dh ? dh->LookupForm(kApiLocalId, kPlugin) : nullptr;
		}

		// SOS_API -> .SOS (the setup quest), the first half of the bind chain.
		RE::BSTSmartPointer<RE::BSScript::Object> QuestObj()
		{
			RE::BSTSmartPointer<RE::BSScript::Object> none;
			auto*                                     f = ApiForm();
			if (!f)
				return none;
			auto api = BindScript(f, kApiScript);
			if (!api)
				return none;
			return ObjProp(api.get(), kQuestProp);
		}

		// A Form-typed Papyrus property resolved through the VM's handle policy
		// — the same idiom faith.cpp uses for Wintersun's globals and spells.
		// Type-checked, so a renamed/retyped property yields nullptr rather than
		// a reinterpreted pointer.
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

		// SOS stores size as the actor's RANK in SOS_SchlongifiedFaction — that
		// is literally what SOS_API.GetSize reads. Reading it natively avoids a
		// sequential VM round trip just to learn the current value.
		// Returns -1 when she has no schlong (SOS_API's own "not schlonged").
		int CurrentSize(RE::Actor* actor)
		{
			auto quest = QuestObj();
			if (!actor || !quest)
				return -1;
			auto* facForm = VarForm(Prop(quest.get(), "SOS_SchlongifiedFaction"),
				RE::FormType::Faction);
			auto* fac = facForm ? facForm->As<RE::TESFaction>() : nullptr;
			if (!fac || !actor->IsInFaction(fac))
				return -1;
			return actor->GetFactionRank(fac, false);
		}

		// SOS_API.SetSize(akActor, size) -> Bool. One dispatch, no chain.
		bool CallSetSize(RE::Actor* actor, std::int32_t size, std::function<void(bool)> done)
		{
			auto* vm = Vm();
			auto* f = ApiForm();
			if (!vm || !f || !actor)
				return false;
			auto* policy = vm->GetObjectHandlePolicy();
			if (!policy)
				return false;
			const auto handle = policy->GetHandleForObject(f->GetFormType(), f);
			if (handle == policy->EmptyHandle())
				return false;
			// ⚠ MakeFunctionArguments needs VALUE types — a forwarded reference
			// instantiates a specialisation that does not exist (the C2027 trap).
			auto args = RE::MakeFunctionArguments(
				std::move(static_cast<RE::Actor*>(actor)), std::move(size));
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb(new Callback(std::move(done)));
			return vm->DispatchMethodCall(handle, kApiScript, "SetSize", args, cb);
		}

		// Who grow/shrink acts on: the actor the palette snapshotted under the
		// crosshair, else the player. The notification always NAMES which, so a
		// mis-aimed press is obvious rather than silent.
		RE::Actor* SizeTarget(bool& wasPlayer)
		{
			wasPlayer = false;
			if (const auto id = NpcActions::TargetFormID(); id) {
				if (auto* a = RE::TESForm::LookupByID<RE::Actor>(id); a && !a->IsDead())
					return a;
			}
			wasPlayer = true;
			return RE::PlayerCharacter::GetSingleton();
		}

		// ------------------------------------------------------ the bind read
		// Walks SOS_API -> SOS (quest) -> config, entirely by property, so no
		// FormID but SOS's own documented one is ever assumed.
		RE::BSTSmartPointer<RE::BSScript::Object> BindConfig()
		{
			RE::BSTSmartPointer<RE::BSScript::Object> none;
			auto*                                     dh = RE::TESDataHandler::GetSingleton();
			if (!dh)
				return none;
			auto* apiForm = dh->LookupForm(kApiLocalId, kPlugin);
			if (!apiForm)
				return none;  // SOS not in this load order
			auto api = BindScript(apiForm, kApiScript);
			if (!api)
				return none;
			auto quest = ObjProp(api.get(), kQuestProp);
			if (!quest)
				return none;
			return ObjProp(quest.get(), kConfigProp);
		}
	}

	namespace {
		using Json = nlohmann::json;
		using Value = RE::BSScript::Variable;
		using ValueDone = std::function<void(Value)>;
		class AppearanceReply final : public RE::BSScript::IStackCallbackFunctor {
			ValueDone done; AppearanceAlive alive;
		public:
			AppearanceReply(ValueDone d, AppearanceAlive a):done(std::move(d)),alive(std::move(a)){}
			void operator()(Value value) override {
				SKSE::GetTaskInterface()->AddTask([d=done,a=alive,value](){if(a()) d(value);});
			}
			bool CanSave() const override{return false;}
			void SetObject(const RE::BSTSmartPointer<RE::BSScript::Object>&) override{}
		};
		template<class...Args> bool AppearanceCall(bool api,const char* fn,ValueDone done,AppearanceAlive alive,Args...args) {
			if(!alive()) return false;
			auto* vm=Vm();if(!vm) return false;
			RE::BSTSmartPointer<RE::BSScript::IStackCallbackFunctor> cb(new AppearanceReply(std::move(done),alive));
			if(!api) return vm->DispatchStaticCall("StorageUtil",fn,RE::MakeFunctionArguments(std::move(args)...),cb);
			auto* form=ApiForm();auto* policy=vm->GetObjectHandlePolicy();if(!form || !policy)return false;
			return vm->DispatchMethodCall(policy->GetHandleForObject(form->GetFormType(),form),kApiScript,fn,RE::MakeFunctionArguments(std::move(args)...),cb);
		}
		void AppearanceResult(const AppearanceDone& done,bool ok,const std::string& msg,const Json& state=nullptr) {
			done(Json{{"ok",ok},{"msg",msg},{"state",state}}.dump(-1,' ',false,Json::error_handler_t::replace));
		}
		std::string SizeSource() {
			auto quest=QuestObj();const auto* v=quest ? quest->GetVariable("SOSRaceMenu") : nullptr;
			if(!v && quest)v=Prop(quest.get(),"SOSRaceMenu");
			return v && v->IsBool() ? (v->GetBool()?"racemenu":"sos") : "";
		}
		RE::TESQuest* ResolveAppearanceAddon(const Json& state) {
			if(!state.is_object() || state.value("mode",std::string())!="addon")return nullptr;
			const auto& id=state.at("addon");auto* dh=RE::TESDataHandler::GetSingleton();
			auto* q=dh ? dh->LookupForm<RE::TESQuest>(id.value("localId",0u),id.value("plugin",std::string())) : nullptr;
			if(!q || id.value("editorId",std::string())!=(q->GetFormEditorID()?q->GetFormEditorID():""))return nullptr;
			return BindScript(q,"SOS_AddonQuest_Script") ? q : nullptr;
		}
		Json AddonIdentity(RE::TESQuest* addon) {
			if(!addon || !addon->GetFile(0) || !addon->GetFormEditorID() || !*addon->GetFormEditorID())
				throw std::runtime_error("This SOS add-on has no stable identity.");
			auto script=BindScript(addon,"SOS_AddonQuest_Script");
			auto* factionForm=script ? VarForm(Prop(script.get(),"SOS_Addon_Faction"),RE::FormType::Faction) : nullptr;
			auto* faction=factionForm ? factionForm->As<RE::TESFaction>() : nullptr;
			std::string name=faction && faction->GetName()?faction->GetName():addon->GetFormEditorID();
			if(name.rfind("SOS ",0)==0)name.erase(0,4);
			return {{"plugin",addon->GetFile(0)->fileName},{"localId",addon->GetLocalFormID()},
				{"editorId",addon->GetFormEditorID()},{"name",name}};
		}
		struct CatalogRead : std::enable_shared_from_this<CatalogRead> {
			AppearanceDone done; AppearanceAlive alive;
			std::vector<RE::TESQuest*> quests;
			Json rows=Json::array();std::size_t at=0;
			void Next() {
				if(!alive())return;
				if(at==quests.size()) {
					AppearanceResult(done,true,"SOS add-ons ready.",{{"sizeSource",SizeSource()},{"addons",rows}});return;
				}
				auto self=shared_from_this();auto* quest=quests[at++];
				if(!AppearanceCall(false,"FormListToArray",[self,quest](Value value){
					try {
						if(!value.IsArray())throw std::runtime_error("SOS's compatible race list is not ready.");
						Json row={{"identity",AddonIdentity(quest)},{"races",Json::array()}};
						if(auto array=value.GetArray()) {
							if(array->size()>4096)throw std::runtime_error("SOS's compatible race list is too large.");
							for(std::uint32_t i=0;i<array->size();++i) {const auto& v=(*array)[i];
								auto* form=VarForm(&v,RE::FormType::Race);auto* race=form?form->As<RE::TESRace>():nullptr;
								if(race && race->GetFile(0))row["races"].push_back({{"plugin",race->GetFile(0)->fileName},
									{"localId",race->GetLocalFormID()},{"editorId",race->GetFormEditorID()?race->GetFormEditorID():""}});
							}
						}
						if(!AppearanceCall(false,"GetIntValue",[self,row](Value gender)mutable{
							if(!gender.IsInt()){AppearanceResult(self->done,false,"SOS's supported sex could not be read.");return;}
							row["gender"]=gender.GetSInt()%10;self->rows.push_back(std::move(row));self->Next();
						},self->alive,static_cast<RE::TESForm*>(quest),RE::BSFixedString("SOS_Genders"),std::int32_t(-1)))
							AppearanceResult(self->done,false,"SOS's supported sex could not be read.");
					}catch(const std::exception& e){AppearanceResult(self->done,false,e.what());}
				},alive,static_cast<RE::TESForm*>(quest),RE::BSFixedString("SOS_CompatibleRaces")))
					AppearanceResult(done,false,"SOS's compatible races could not be read.");
			}
		};
	}

	void ReadAppearanceCatalog(AppearanceDone done,AppearanceAlive alive) {
		if(!alive())return;
		if(!ApiForm() || !QuestObj() || SizeSource().empty()){
			AppearanceResult(done,false,"SOS is not installed or has not finished loading.");return;
		}
		auto read=std::make_shared<CatalogRead>();read->done=std::move(done);read->alive=std::move(alive);
		if(!AppearanceCall(false,"FormListToArray",[read](Value value){
			if(!value.IsArray()){AppearanceResult(read->done,false,"SOS's registered add-ons are not ready.");return;}
			if(auto array=value.GetArray()) {
				if(array->size()>256){AppearanceResult(read->done,false,"SOS's registered add-on list is too large.");return;}
				for(std::uint32_t i=0;i<array->size();++i){const auto& v=(*array)[i];auto* form=VarForm(&v,RE::FormType::Quest);if(form)read->quests.push_back(form->As<RE::TESQuest>());}
			}
			read->Next();
		},read->alive,static_cast<RE::TESForm*>(nullptr),RE::BSFixedString("SOS_Addons")))
			AppearanceResult(read->done,false,"SOS's registered add-ons could not be read.");
	}

	void CaptureAppearance(AppearanceDone done,AppearanceAlive alive) {
		if(!alive())return;
		if(!ApiForm()){AppearanceResult(done,true,"SOS is not installed.",{{"version",1},{"mode","unmanaged"}});return;}
		auto* player=RE::PlayerCharacter::GetSingleton();
		if(!player || !player->Is3DLoaded() || !QuestObj() || SizeSource().empty()){
			AppearanceResult(done,false,"Wait for SOS and your character to finish loading.");return;
		}
		if(!AppearanceCall(true,"GetSchlong",[done](Value value){
			try {
				auto* player=RE::PlayerCharacter::GetSingleton();
				if(value.IsBool() || value.IsInt() || value.IsFloat() || value.IsString() || value.IsArray())
					throw std::runtime_error("SOS returned an invalid add-on result.");
				auto* form=VarForm(&value,RE::FormType::Quest);auto* addon=form?form->As<RE::TESQuest>():nullptr;
				const int size=CurrentSize(player);
				if(!addon) {
					if(size>=0)throw std::runtime_error("SOS's current add-on and size disagree. Refresh SOS before saving this look.");
					AppearanceResult(done,true,"No SOS add-on assigned.",{{"version",1},{"mode","none"}});return;
				}
				Json state={{"version",1},{"mode","addon"},{"addon",AddonIdentity(addon)},
					{"size",size},{"sizeSource",SizeSource()}};
				SosAppearanceModel::Validate(state);AppearanceResult(done,true,"SOS settings captured.",state);
			}catch(const std::exception& e){AppearanceResult(done,false,e.what());}
		},alive,static_cast<RE::Actor*>(player)))AppearanceResult(done,false,"SOS could not read your current add-on.");
	}

	std::string AppearanceProblem(const std::string& saved) {
		try {
			const auto state=Json::parse(saved);SosAppearanceModel::Validate(state);
			if(!SosAppearanceModel::Managed(state))return "";
			if(!ApiForm() || !QuestObj())return "SOS is required by this saved look and is not ready.";
			if(state.value("mode",std::string())=="addon") {
				if(!ResolveAppearanceAddon(state))return "The saved SOS add-on is unavailable or its identity changed.";
				if(SizeSource()!=state.value("sizeSource",std::string()))return "SOS size control changed. Restore the original SOS/RaceMenu setup or replace this saved look.";
			}
			return "";
		}catch(const std::exception& e){return e.what();}
	}

	void ValidateAppearance(const std::string& saved,std::uint32_t raceId,bool female,AppearanceDone done,AppearanceAlive alive) {
		if(!alive())return;
		const auto problem=AppearanceProblem(saved);
		if(!problem.empty()){AppearanceResult(done,false,problem);return;}
		const auto state=Json::parse(saved);
		if(!SosAppearanceModel::Managed(state) || state.value("mode",std::string())=="none") {AppearanceResult(done,true,"SOS settings ready.");return;}
		auto* addon=ResolveAppearanceAddon(state);auto* race=RE::TESForm::LookupByID<RE::TESRace>(raceId);
		if(!addon || !race){AppearanceResult(done,false,"The saved SOS add-on or race is unavailable.");return;}
		// The exact winning SOS scripts use these StorageUtil keys. Read live
		// registration/compatibility, not the add-on's initial CK property lists.
		if(!AppearanceCall(false,"FormListHas",[=](Value registered){
			if(!registered.IsBool() || !registered.GetBool()){AppearanceResult(done,false,"The saved SOS add-on has not registered yet. Let SOS finish loading.");return;}
			if(!AppearanceCall(false,"FormListHas",[=](Value compatible){
				if(!compatible.IsBool() || !compatible.GetBool()){AppearanceResult(done,false,"The saved SOS add-on does not support this look's race.");return;}
				if(!AppearanceCall(false,"GetIntValue",[=](Value gender){
					const int value=gender.IsInt()?gender.GetSInt()%10:-1;
					const bool ok=value==2 || value==(female?1:0);
					AppearanceResult(done,ok,ok?"SOS settings ready.":"The saved SOS add-on does not support this look's sex.");
				},alive,static_cast<RE::TESForm*>(addon),RE::BSFixedString("SOS_Genders"),std::int32_t(-1)))
					AppearanceResult(done,false,"SOS's gender compatibility could not be read.");
			},alive,static_cast<RE::TESForm*>(addon),RE::BSFixedString("SOS_CompatibleRaces"),static_cast<RE::TESForm*>(race)))
				AppearanceResult(done,false,"SOS's race compatibility could not be read.");
		},alive,static_cast<RE::TESForm*>(nullptr),RE::BSFixedString("SOS_Addons"),static_cast<RE::TESForm*>(addon)))
			AppearanceResult(done,false,"SOS's registered add-ons could not be read.");
	}

	void VerifyAppearance(const std::string& saved,AppearanceDone done,AppearanceAlive alive) {
		const auto state=Json::parse(saved);
		if(!SosAppearanceModel::Managed(state)){if(alive())AppearanceResult(done,true,"This older look has no SOS settings.");return;}
		CaptureAppearance([=](std::string result){
			try {
				const auto r=Json::parse(result);
				const bool ok=r.value("ok",false) && SosAppearanceModel::Matches(state,r.at("state"));
				logger::info("appearance-sos: verified={} mode={}",ok,state.value("mode",std::string()));
				AppearanceResult(done,ok,ok?"Saved SOS type and size restored.":"SOS did not retain this look's saved type and size.");
			}catch(const std::exception& e){AppearanceResult(done,false,e.what());}
		},alive);
	}

	void ApplyAppearance(const std::string& saved,AppearanceDone done,AppearanceAlive alive) {
		if(!alive())return;
		const auto problem=AppearanceProblem(saved);
		if(!problem.empty()){AppearanceResult(done,false,problem);return;}
		const auto state=Json::parse(saved);
		if(!SosAppearanceModel::Managed(state)){AppearanceResult(done,true,"This older look has no SOS settings.");return;}
		auto* player=RE::PlayerCharacter::GetSingleton();
		if(!player || !player->Is3DLoaded()){AppearanceResult(done,false,"The player is not ready for SOS.");return;}
		if(state.value("mode",std::string())=="none") {
			// SOS owns removal and its per-actor blacklist. SetSchlong clears that
			// blacklist when another saved look intentionally selects an add-on.
			if(!AppearanceCall(true,"RemoveSchlong",[=](Value removed){
				if(!removed.IsBool() || !removed.GetBool()){AppearanceResult(done,false,"SOS could not restore the look without an add-on.");return;}
				VerifyAppearance(saved,done,alive);
			},alive,static_cast<RE::Actor*>(player)))AppearanceResult(done,false,"SOS removal is unavailable.");
			return;
		}
		auto* addon=ResolveAppearanceAddon(state);
		// GetSchlong first: SetSchlong with the SAME add-on can remove its own
		// equipped armor (SetSchlongType's old-armor cleanup). Skip that call.
		if(!AppearanceCall(true,"GetSchlong",[=](Value current){
			auto resize=[=]() {
				if(!alive())return;
				if(!AppearanceCall(true,"SetSize",[=](Value sized){
					if(!sized.IsBool() || !sized.GetBool()){AppearanceResult(done,false,"SOS refused the saved size.");return;}
					VerifyAppearance(saved,done,alive);
				},alive,static_cast<RE::Actor*>(player),std::int32_t(state.at("size").get<int>())))
					AppearanceResult(done,false,"SOS size restoration is unavailable.");
			};
			if(VarForm(&current,RE::FormType::Quest)==addon){resize();return;}
			if(!AppearanceCall(true,"SetSchlong",[=](Value assigned){
				if(!assigned.IsBool() || !assigned.GetBool()){AppearanceResult(done,false,"SOS refused the saved add-on.");return;}
				resize();
			},alive,static_cast<RE::Actor*>(player),static_cast<RE::TESForm*>(addon)))
				AppearanceResult(done,false,"SOS add-on restoration is unavailable.");
		},alive,static_cast<RE::Actor*>(player)))AppearanceResult(done,false,"SOS could not read the active add-on.");
	}

	Binds Read()
	{
		Binds b{ kDefUp, kDefDown, kDefMod, false };
		auto  cfg = BindConfig();
		if (!cfg)
			return b;
		const int up = VarInt(Prop(cfg.get(), "iBendUpKey"), -1);
		const int down = VarInt(Prop(cfg.get(), "iBendDownKey"), -1);
		const int mod = VarInt(Prop(cfg.get(), "iBendPlayerModifierKey"), -1);
		// Only claim "live" when the chain really answered. A single readable
		// value is enough to prove we reached the config; each field is then
		// taken on its own merit, and an unbound (0) one stays 0 rather than
		// being back-filled with a default SOS is not listening for.
		if (up < 0 && down < 0 && mod < 0)
			return b;
		b.live = true;
		b.up = SaneCode(up) ? static_cast<std::uint32_t>(up) : 0u;
		b.down = SaneCode(down) ? static_cast<std::uint32_t>(down) : 0u;
		b.playerMod = SaneCode(mod) ? static_cast<std::uint32_t>(mod) : 0u;
		return b;
	}

	bool IsAction(const std::string& a)
	{
		return a == "sos-bend-up" || a == "sos-bend-down" ||
		       a == "sos-bend-up-player" || a == "sos-bend-down-player" ||
		       a == "sos-size-up" || a == "sos-size-down";
	}

	std::string SizeStateJson(std::uint32_t formId)
	{
		using json = nlohmann::json;
		auto* actor = RE::TESForm::LookupByID<RE::Actor>(formId);
		const bool present = ApiForm() != nullptr;
		const int size = actor && present ? CurrentSize(actor) : -1;
		// The winning SOS_SetupQuest_Script.pex skips PLAYER bone scaling when
		// its plain SOSRaceMenu variable is true, even though SetSize returns
		// true and updates the faction ranks. Never offer that as a resize.
		const bool player = actor && actor == RE::PlayerCharacter::GetSingleton();
		auto quest = QuestObj();
		const auto* raceMenu = quest ? quest->GetVariable("SOSRaceMenu") : nullptr;
		if (!raceMenu && quest) raceMenu = Prop(quest.get(), "SOSRaceMenu");
		const bool ownerKnown = raceMenu && raceMenu->IsBool();
		const bool raceMenuOwnsPlayer = player && ownerKnown && raceMenu->GetBool();
		std::string reason;
		if (!present) reason = "Schlongs of Skyrim is not loaded";
		else if (!actor || !actor->Get3D()) reason = "Participant is not loaded";
		else if (actor->IsDead()) reason = "Participant is dead";
		else if (player && !ownerKnown) reason = "Cannot verify whether SOS or RaceMenu controls player size";
		else if (raceMenuOwnsPlayer) reason = "Player size is controlled by SOS RaceMenu; adjust it in RaceMenu";
		else if (size < kMinSize || size > kMaxSize) reason = "No supported SOS size for this participant";
		const bool available = reason.empty();
		return json{{"ok",true},{"formId",formId},{"present",present},{"available",available},
			{"size",available?json(size):json(nullptr)},{"min",kMinSize},{"max",kMaxSize},
			{"msg",reason}}
			.dump(-1,' ',false,json::error_handler_t::replace);
	}
	void SetActorSize(std::uint32_t formId,int size,std::function<void(std::string)> done)
	{
		using json = nlohmann::json;
		auto finish=[done](json j){done(j.dump(-1,' ',false,json::error_handler_t::replace));};
		if(size<kMinSize||size>kMaxSize){finish({{"ok",false},{"msg","SOS size must be an integer from 1 to 20"}});return;}
		auto state=json::parse(SizeStateJson(formId));
		if(!state.value("available",false)){state["ok"]=false;finish(state);return;}
		if(state["size"].get<int>()==size){state["msg"]="Size already matches";finish(state);return;}
		auto* actor=RE::TESForm::LookupByID<RE::Actor>(formId);
		logger::info("sos-size: explicit scene actor {:08X} -> {}",formId,size);
		if(!CallSetSize(actor,size,[formId,size,finish](bool accepted){
			auto out=json::parse(SizeStateJson(formId));
			const bool matches=out.value("available",false)&&out["size"].get<int>()==size;
			out["ok"]=accepted&&matches;
			out["msg"]=!accepted?"SOS refused the size change":matches?"SOS stored size updated":"SOS accepted the request but size readback differs; refresh to check";
			finish(out);
		}))finish({{"ok",false},{"msg","SOS size control is unavailable"}});
	}

	// Grow / shrink by one step, through SOS's own SetSize. Unlike bend there IS
	// an API for this, so nothing is synthesized: read the current size natively
	// (it is the faction rank SOS_API.GetSize itself reads), clamp, and dispatch
	// ONE call. SOS_API bounds size at 1..20 and refuses anything else, so the
	// clamp here is what turns "already at the top" into a sentence instead of a
	// silently rejected call.
	void FireSize(bool grow)
	{
		bool  onPlayer = false;
		auto* actor = SizeTarget(onPlayer);
		if (!actor) {
			RE::DebugNotification("Nobody to resize");
			return;
		}
		const std::string who = onPlayer
			? std::string("you")
			: std::string(actor->GetDisplayFullName() ? actor->GetDisplayFullName() : "them");

		if (!ApiForm()) {
			logger::warn("sos-size: Schlongs of Skyrim is not in this load order");
			RE::DebugNotification("SOS not found - nothing to resize");
			return;
		}
		const int cur = CurrentSize(actor);
		if (cur < 0) {
			logger::info("sos-size: {} has no SOS schlong, so there is no size to change", who);
			RE::DebugNotification(onPlayer ? "You have no SOS schlong to resize"
										   : "They have no SOS schlong to resize");
			return;
		}
		const int want = grow ? cur + 1 : cur - 1;
		if (want < kMinSize || want > kMaxSize) {
			logger::info("sos-size: {} is already at {} ({} of {}..{})", who, cur,
				grow ? "max" : "min", kMinSize, kMaxSize);
			RE::DebugNotification(grow ? "Already at SOS's maximum size"
									   : "Already at SOS's minimum size");
			return;
		}
		logger::info("sos-size: {} {} -> {} via SOS_API.SetSize", who, cur, want);   // marker: sos-size
		// Share the scene controller's ownership guard and observed rank check.
		SetActorSize(actor->GetFormID(), want, [](std::string raw) {
			const auto result = nlohmann::json::parse(raw);
			const auto msg = result.value("msg", std::string("SOS size request finished"));
			RE::DebugNotification(msg.c_str());
		});
	}

	void Fire(const std::string& a)
	{
		if (!IsAction(a))
			return;

		if (a == "sos-size-up" || a == "sos-size-down") {
			FireSize(a == "sos-size-up");
			return;
		}

		// Read on the CALLING thread: these are VM data reads and the caller
		// already runs inside a main-thread task.
		const Binds b = Read();
		const bool  wantPlayer = (a == "sos-bend-up-player" || a == "sos-bend-down-player");
		const bool  wantUp = (a == "sos-bend-up" || a == "sos-bend-up-player");
		const std::uint32_t key = wantUp ? b.up : b.down;
		const std::uint32_t mod = wantPlayer ? b.playerMod : 0u;

		if (!key) {
			// Honest refusal beats firing a key SOS is not watching.
			logger::warn("sos-bend: '{}' has no key - SOS {} (up {} down {} mod {})",
				a, b.live ? "is installed but that bend key is unbound in its MCM" : "was not found in this load order",
				b.up, b.down, b.playerMod);
			RE::DebugNotification(b.live
					? "SOS: that bend key is unbound in SOS's MCM"
					: "SOS not found - nothing to bend");
			return;
		}
		if (wantPlayer && !mod) {
			logger::warn("sos-bend: '{}' wants the player modifier but SOS has it unbound - "
			             "firing the plain bend, which targets your crosshair instead",
				a);
			RE::DebugNotification("SOS: player-bend modifier is unbound - bending your target");
		}

		logger::info("sos-bend: {} -> scan {:#x}{} ({} binds)", a, key,
			mod ? (" with modifier " + std::to_string(mod)) : std::string{},
			b.live ? "live SOS" : "SOS default");

		std::thread([key, mod]() {
			// Let the palette finish closing and the game unpause: SOS's
			// handler is Papyrus, and Papyrus runs unpaused only.
			std::this_thread::sleep_for(std::chrono::milliseconds(90));
			TapChord(key, mod);
		}).detach();
	}
}
